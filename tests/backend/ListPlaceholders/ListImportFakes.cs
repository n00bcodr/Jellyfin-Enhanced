using System.Collections.Concurrent;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;

namespace JE.Tests;

/// <summary>An in-memory Seerr for the import resolver: canned searches, details, seasons and IMDb episode finds.</summary>
internal sealed class FakeImportLookup : IImportLookup
{
    private readonly ConcurrentDictionary<string, int> _emptyLeft = new(StringComparer.Ordinal);

    public bool IsConfigured { get; set; } = true;
    public bool CanFindImdbEpisodes { get; set; }
    public Dictionary<string, List<TitleHit>> Searches { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<(string Type, int Id), TitleDetails> Details { get; } = new();
    public Dictionary<(int Id, int Season), List<EpisodeFacts>> Seasons { get; } = new();
    public Dictionary<string, ImdbEpisodeFind> ImdbEpisodes { get; } = new(StringComparer.Ordinal);
    public HashSet<string> TransientQueries { get; } = new(StringComparer.OrdinalIgnoreCase);
    public TimeSpan Delay { get; set; }
    public ConcurrentQueue<string> Log { get; } = new();

    /// <summary>The next <paramref name="times"/> searches for the query come back empty (Seerr hiding a TMDB error).</summary>
    public void EmptyFirst(string query, int times = 1) => _emptyLeft[query.ToLowerInvariant()] = times;

    public static TitleHit Movie(int id, string title, string? date, int votes = 1000, double popularity = 10, string? original = null) =>
        new("movie", id, title, original, date, null, null, popularity, votes);

    public static TitleHit Tv(int id, string title, string? date, int votes = 1000, double popularity = 10) =>
        new("tv", id, title, null, date, null, null, popularity, votes);

    public void AddSearch(string query, params TitleHit[] hits) => Searches[query] = hits.ToList();

    public void AddShow(TitleHit show, params SeasonFacts[] seasons) =>
        Details[("tv", show.TmdbId)] = new TitleDetails(show, null, null, "Ended", false, seasons);

    public async Task<LookupResult<IReadOnlyList<TitleHit>>> SearchAsync(string query, ImportCallContext context, CancellationToken cancellationToken)
    {
        await Pause(cancellationToken);
        context.CountCall();
        Log.Enqueue("search:" + query);
        if (TransientQueries.Contains(query))
        {
            return LookupResult<IReadOnlyList<TitleHit>>.Transient;
        }

        var key = query.ToLowerInvariant();
        if (_emptyLeft.TryGetValue(key, out var left) && left > 0)
        {
            _emptyLeft[key] = left - 1;
            return new LookupResult<IReadOnlyList<TitleHit>>(LookupStatus.Ok, Array.Empty<TitleHit>());
        }

        if (query.StartsWith("tmdb:", StringComparison.Ordinal) && int.TryParse(query[5..], out var tmdb))
        {
            return Ok<IReadOnlyList<TitleHit>>(Details.Where(d => d.Key.Id == tmdb).Select(d => d.Value.Hit).ToList());
        }

        return Ok<IReadOnlyList<TitleHit>>(Searches.TryGetValue(query, out var hits) ? hits : new List<TitleHit>());
    }

    public async Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken)
    {
        await Pause(cancellationToken);
        context.CountCall();
        Log.Enqueue($"details:{mediaType}/{tmdbId}");
        if (Details.TryGetValue((mediaType, tmdbId), out var details))
        {
            return Ok(details);
        }

        // A search hit without registered details: plain details with no seasons.
        var hit = Searches.Values.SelectMany(h => h).FirstOrDefault(h => h.MediaType == mediaType && h.TmdbId == tmdbId);
        return hit == null ? LookupResult<TitleDetails>.NotFound : Ok(new TitleDetails(hit, null, null, null, null, Array.Empty<SeasonFacts>()));
    }

    public async Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken)
    {
        await Pause(cancellationToken);
        context.CountCall();
        Log.Enqueue($"season:{tvTmdbId}/{season}");
        return Seasons.TryGetValue((tvTmdbId, season), out var episodes) ? Ok<IReadOnlyList<EpisodeFacts>>(episodes) : LookupResult<IReadOnlyList<EpisodeFacts>>.NotFound;
    }

    public Task<LookupResult<ImdbEpisodeFind>> FindImdbEpisodeAsync(string imdbId, CancellationToken cancellationToken)
    {
        Log.Enqueue("find:" + imdbId);
        return Task.FromResult(ImdbEpisodes.TryGetValue(imdbId, out var found) ? Ok(found) : LookupResult<ImdbEpisodeFind>.NotFound);
    }

    private static LookupResult<T> Ok<T>(T value) => new(LookupStatus.Ok, value);

    private Task Pause(CancellationToken cancellationToken) => Delay > TimeSpan.Zero ? Task.Delay(Delay, cancellationToken) : Task.CompletedTask;
}

/// <summary>Library lookups by scope; records the users each lookup had to satisfy.</summary>
internal sealed class FakeLibraryLookup : IListLibraryLookup
{
    public Dictionary<(string Kind, int Tmdb), LibraryMatch> Matches { get; } = new();
    public List<(LibraryScope Scope, IReadOnlyList<User> Users)> Calls { get; } = new();

    public LibraryMatch? Find(LibraryScope scope, IReadOnlyList<User> users, int? expectedEpisodes)
    {
        lock (Calls)
        {
            Calls.Add((scope, users));
        }

        return Matches.TryGetValue((scope.Kind, scope.TmdbId), out var match) ? match : null;
    }

    /// <summary>What library items stand for (besides the movie matches, which answer for themselves).</summary>
    public Dictionary<Guid, List<string>> Identities { get; } = new();

    public IReadOnlyList<string> SourceKeysOf(Guid itemId) =>
        Identities.TryGetValue(itemId, out var keys) ? keys
        : Matches.Where(m => m.Key.Kind == "movie" && m.Value.ItemId == itemId).Select(m => $"movie|{m.Key.Tmdb}||").ToList();
}

/// <summary>A list source whose content tests change between syncs.</summary>
internal sealed class FakeSourceFetcher : IListSourceFetcher
{
    public List<SourceItem> Items { get; set; } = new();
    public bool Truncated { get; set; }
    public bool Partial { get; set; }
    public bool Exact { get; set; }
    public string? FailCode { get; set; }
    public int? RetryAfter { get; set; }
    public string Provider { get; set; } = "mdblist";
    public List<SourceFetchOptions> Calls { get; } = new();

    /// <summary>Runs during a fetch (what happens upstream or in the list while a sync is fetching).</summary>
    public Func<Task>? OnFetch { get; set; }

    public async Task<SourceFetchResult> FetchAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
    {
        Calls.Add(options);
        if (OnFetch != null)
        {
            await OnFetch().ConfigureAwait(false);
        }

        if (FailCode != null)
        {
            return SourceFetchResult.Fail(source, FailCode, "Upstream says no.", RetryAfter);
        }

        return new SourceFetchResult
        {
            Ok = true,
            Kind = source.Kind,
            Provider = Provider,
            CanonicalUrl = source.CanonicalUrl,
            Title = "Fake list",
            Items = Items.ToList(),
            Total = Items.Count,
            Truncated = Truncated,
            Partial = Partial,
            Exact = Exact,
        };
    }

    public SourceProvidersDto Providers() => new() { MaxItems = ListSourceFetcher.MaxItems, SyncEnabled = true };
}

/// <summary>Removes real entries from the fake Jellyfin lists (every copy, like Jellyfin).</summary>
internal sealed class FakeEntryRemover(FakeListHost host) : IListEntryRemover
{
    public List<Guid> Removed { get; } = new();

    public Task RemoveAsync(ListInfo list, IReadOnlyList<Guid> itemIds)
    {
        Removed.AddRange(itemIds);
        host.Lists[list.Id].Raw.RemoveAll(r => r.ItemId.HasValue && itemIds.Contains(r.ItemId.Value));
        return Task.CompletedTask;
    }
}

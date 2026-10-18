using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>
    /// The URL half of the import review (design §8 F1–F6, preview only): reads a list URL through
    /// <see cref="IListSourceFetcher"/> and answers its entries with ids for the review, filtered for restricted callers
    /// (C5) before anything else. Exact sources (Chronolists) come back grouped into runs, each entry with all its source
    /// keys and a prepared resolution, so no title lookup is needed. Nothing here changes a list or stores a link: the
    /// apply and linked sync (track 4c2b) take the same fetch (the fetcher's short cache) and re-check everything.
    /// </summary>
    public sealed class ListSourcePreview
    {
        /// <summary>How long grouping an exact source waits for the season episode counts (shows not answered by then
        /// get no whole-season entries).</summary>
        public static readonly TimeSpan SeasonCountBudget = TimeSpan.FromSeconds(10);

        private readonly IListSourceFetcher _fetcher;
        private readonly ListImportResolver _resolver;
        private readonly ListAccessService _access;
        private readonly IImportViewerPolicy? _viewer;
        private readonly Logger _logger;

        /// <summary>Creates the service (DI).</summary>
        /// <param name="fetcher">Source fetcher.</param>
        /// <param name="resolver">Import resolver (library matches, season counts).</param>
        /// <param name="access">Access service (parental checks).</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="viewer">Hidden Content / Spoiler Guard rules of the caller.</param>
        public ListSourcePreview(IListSourceFetcher fetcher, ListImportResolver resolver, ListAccessService access, Logger logger, IImportViewerPolicy? viewer = null)
        {
            _fetcher = fetcher;
            _resolver = resolver;
            _access = access;
            _logger = logger;
            _viewer = viewer;
        }

        /// <summary>Provider capabilities (GET import/providers).</summary>
        /// <param name="caller">The caller (the MDBList API path is only reported to administrators).</param>
        /// <returns>Capabilities.</returns>
        public SourceProvidersDto Providers(User caller)
        {
            var providers = _fetcher.Providers(caller);
            providers.ResolveChunk = ListImportResolver.MaxEntriesPerCall;
            providers.MetadataProvider = _resolver.Provider;
            return providers;
        }

        /// <summary>
        /// Fetches a list URL for the import review: entries with ids, filtered for restricted callers. Exact sources
        /// come back grouped (see the class remarks), plus every key of the entries shown as
        /// <see cref="SourceFetchResponse.SnapshotKeys"/>.
        /// </summary>
        /// <param name="caller">Caller.</param>
        /// <param name="request">URL and options.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <param name="libraryUsers">Users that must see an "in library" match (default: the caller; with a target
        /// playlist also its owner).</param>
        /// <returns><see cref="SourceFetchResponse"/>, or an error (504 parental_pending when checks didn't finish).</returns>
        public async Task<ListOutcome> FetchAsync(User caller, SourceFetchRequest request, CancellationToken cancellationToken, IReadOnlyList<User>? libraryUsers = null)
        {
            if (!ListSourceUrl.TryParse(request.Url, out var source, out var parseError))
            {
                return SourceOutcomes.ParseFailure(parseError);
            }

            var options = new SourceFetchOptions
            {
                AllowMdblistApi = request.UseMdblistApi && ListAccessService.IsAdmin(caller),
                Caller = caller.Id.ToString("N", CultureInfo.InvariantCulture),
            };
            var result = await _fetcher.FetchAsync(source!, options, cancellationToken).ConfigureAwait(false);
            if (!result.Ok)
            {
                return SourceOutcomes.FetchFailure(result);
            }

            var response = new SourceFetchResponse
            {
                Kind = result.Kind,
                Provider = result.Provider,
                Url = result.CanonicalUrl,
                Title = result.Title,
                Unofficial = result.Unofficial,
                Notice = result.Notice,
                Total = result.Total,
                Truncated = result.Truncated,
                Partial = result.Partial,
            };

            var items = result.Items.Where(i => i.Key != null).ToList();
            response.Dropped = result.Items.Count - items.Count;
            var restricted = _access.IsRestricted(caller);
            var filtered = false;
            if (restricted)
            {
                var (allowed, pending) = await FilterRestrictedAsync(items, caller, cancellationToken).ConfigureAwait(false);
                if (pending)
                {
                    return new ListOutcome { StatusCode = 504, RetryAfterSeconds = 2, Value = new ListErrorDto { Code = "parental_pending", Message = "Checking titles against your parental controls; try again in a moment." } };
                }

                filtered = allowed.Count < items.Count;
                items = allowed;
            }

            var viewer = _viewer?.For(caller) ?? ImportViewer.None;
            if (result.Exact)
            {
                await PrepareGroupedEntriesAsync(response, result.Items, items, libraryUsers ?? new[] { caller }, caller, viewer, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                response.Entries = items.Select((item, i) => ToEntry(item, i)).ToList();
            }

            if (filtered)
            {
                // A2: nothing says how many entries the caller's controls left out (totals, unusable rows, the digest).
                response.CountsHidden = true;
                response.Total = 0;
                response.Dropped = 0;
            }
            else
            {
                response.Snapshot = SourceSnapshots.Describe(result);
            }

            return ListOutcome.Ok(response);
        }

        /// <summary>A fetched entry as an import entry (feed it to resolve; carries its source key).</summary>
        /// <param name="item">Source entry.</param>
        /// <param name="index">Position.</param>
        /// <returns>The entry.</returns>
        public static ImportEntryDto ToEntry(SourceItem item, int index)
        {
            var ids = new ImportIdsDto
            {
                Tmdb = item.TmdbId,
                TmdbType = item.TmdbId.HasValue ? item.MediaType : null,
                Imdb = item.ImdbId,
                Tvdb = item.MediaType == "tv" ? item.TvdbId : null,
            };
            return new ImportEntryDto
            {
                Index = index,
                Title = item.Title,
                Year = item.Year,
                TypeHint = item.MediaType,
                Season = item.Season,
                Episodes = item.Season.HasValue && item.Episode.HasValue ? new List<ImportEpisodeDto> { new() { S = item.Season.Value, E = item.Episode.Value } } : null,
                Ids = ids,
                Note = item.Note,
                SourceKey = item.Key,
            };
        }

        /// <summary>
        /// Keyed entries (first occurrence of each key) with their positions in the whole list, plus the list facts.
        /// </summary>
        /// <param name="all">Every fetched entry, in list order.</param>
        /// <param name="subset">The entries to keep (by reference), or null for all.</param>
        /// <returns>The positioned entries and the facts.</returns>
        public static (List<(SourceItem Item, int Position)> Positioned, SourceListFacts Facts) Positioned(IReadOnlyList<SourceItem> all, IReadOnlyList<SourceItem>? subset = null)
        {
            var keep = subset == null ? null : new HashSet<SourceItem>(subset, ReferenceEqualityComparer.Instance);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var positioned = new List<(SourceItem, int)>();
            var keyed = new List<SourceItem>();
            for (var i = 0; i < all.Count; i++)
            {
                var item = all[i];
                if (item.Key is not { } key || !seen.Add(key))
                {
                    continue;
                }

                keyed.Add(item);
                if (keep == null || keep.Contains(item))
                {
                    positioned.Add((item, i));
                }
            }

            return (positioned, ListSourceGroups.Facts(keyed));
        }

        /// <summary>
        /// Exact sources: TMDB's episode counts of the seasons a run could cover whole (the shows whose E1 of a season is
        /// among <paramref name="positioned"/>), one cached title lookup per show within <see cref="SeasonCountBudget"/>.
        /// Without a title lookup, or for a show that doesn't answer in time, nothing is added and its runs become
        /// episodes entries (never a season one that would stand for episodes the list doesn't have).
        /// </summary>
        /// <param name="facts">Facts to fill in.</param>
        /// <param name="positioned">Positioned entries.</param>
        /// <param name="context">Lookup owner/priority.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>A task.</returns>
        public async Task AddSeasonCountsAsync(SourceListFacts facts, IEnumerable<(SourceItem Item, int Position)> positioned, ImportCallContext context, CancellationToken cancellationToken)
        {
            var shows = positioned.Select(p => p.Item)
                .Where(i => i.MediaType == "tv" && i.TmdbId is > 0 && i.Season is > 0 && i.Episode == 1)
                .Select(i => i.TmdbId!.Value)
                .Distinct()
                .ToList();
            if (shows.Count == 0 || !_resolver.IsAvailable)
            {
                return;
            }

            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(SeasonCountBudget);
            var answers = await Task.WhenAll(shows.Select(async show =>
            {
                try
                {
                    return (Show: show, Counts: await _resolver.GetSeasonEpisodeCountsAsync(show, context, budget.Token).ConfigureAwait(false));
                }
                catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
                {
                    _logger.Debug($"[Lists] Season episode counts of TMDB show {show} unavailable: {ex.Message}");
                    return (Show: show, Counts: (IReadOnlyDictionary<int, int>?)null);
                }
            })).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var (show, counts) in answers)
            {
                foreach (var (season, count) in counts ?? new Dictionary<int, int>())
                {
                    facts.SeasonEpisodes[(show, season)] = count;
                }
            }
        }

        // Exact sources: group the (allowed) entries by their positions in the whole list, prepare each group's
        // resolution and library match, and hand out every key of what is shown as the snapshot.
        private async Task PrepareGroupedEntriesAsync(SourceFetchResponse response, IReadOnlyList<SourceItem> all, IReadOnlyList<SourceItem> allowed, IReadOnlyList<User> libraryUsers, User caller, ImportViewer viewer, CancellationToken cancellationToken)
        {
            var (positioned, facts) = Positioned(all, allowed);
            await AddSeasonCountsAsync(facts, positioned, new ImportCallContext(caller.Id.ToString("N", CultureInfo.InvariantCulture), false), cancellationToken).ConfigureAwait(false);
            var groups = ListSourceGroups.Group(positioned, facts);
            if (groups.Count > ListStore.MaxPlaceholders)
            {
                groups = groups.Take(ListStore.MaxPlaceholders).ToList();
                response.Truncated = true;
            }

            var library = new GroupLibrary(_resolver, libraryUsers);
            response.Grouped = true;
            response.Entries = groups.Select((group, i) => ListSourceGroups.Entry(group, i, facts, library.Find(group))).ToList();
            foreach (var entry in response.Entries)
            {
                if (entry.Prepared != null)
                {
                    viewer.Project(entry.Prepared);
                }
            }

            response.SnapshotKeys = groups.SelectMany(g => g.Keys).ToList();
            response.Dropped += positioned.Count < allowed.Count ? allowed.Count - positioned.Count : 0;
        }

        // C5 for fetched lists: restricted callers keep only TMDB titles their parental controls allow. Unknown (an
        // unrated title, a failed lookup) is hidden; only a check that ran out of time asks the caller to try again.
        private async Task<(List<SourceItem> Allowed, bool Pending)> FilterRestrictedAsync(List<SourceItem> items, User caller, CancellationToken cancellationToken)
        {
            var pending = false;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(ListImportResolver.ParentalBudget);
            using var gate = new SemaphoreSlim(8);
            var userIdN = caller.Id.ToString("N", CultureInfo.InvariantCulture);
            // One check per title (a watch order lists hundreds of episodes of a few shows).
            var titles = items.Where(i => i.TmdbId is > 0).Select(i => (i.MediaType, i.TmdbId!.Value)).Distinct().ToList();
            var verdicts = await Task.WhenAll(titles.Select(async title =>
            {
                try
                {
                    await gate.WaitAsync(budget.Token).ConfigureAwait(false);
                    try
                    {
                        return await _access.CheckTitleAsync(title.MediaType, title.Value, userIdN, budget.Token).ConfigureAwait(false) == true;
                    }
                    finally
                    {
                        gate.Release();
                    }
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    pending = true;
                    return false;
                }
            })).ConfigureAwait(false);
            var verdict = new Dictionary<(string, int), bool>();
            for (var i = 0; i < titles.Count; i++)
            {
                verdict[titles[i]] = verdicts[i];
            }

            // Entries without a TMDB id are unverifiable for a restricted user: hidden.
            return (items.Where(i => i.TmdbId is > 0 && verdict[(i.MediaType, i.TmdbId.Value)]).ToList(), pending);
        }

        /// <summary>
        /// Library matches of groups, looking each show and each season up once: most shows of a watch order aren't in the
        /// library, and a run is only looked up when its season is (a run lookup reads the season's episodes).
        /// </summary>
        private sealed class GroupLibrary(ListImportResolver resolver, IReadOnlyList<User> users)
        {
            private readonly Dictionary<int, bool> _shows = new();
            private readonly Dictionary<(int, int), ImportLibraryDto?> _seasons = new();

            public ImportLibraryDto? Find(SourceGroup group)
            {
                var first = group.First;
                if (first.MediaType == "tv")
                {
                    var show = first.TmdbId!.Value;
                    if (!_shows.TryGetValue(show, out var present))
                    {
                        present = resolver.FindInLibrary(new LibraryScope(PlaceholderKinds.Series, show, first.TvdbId, first.ImdbId, null, null), users, null) != null;
                        _shows[show] = present;
                    }

                    if (!present)
                    {
                        return null;
                    }

                    if (first.Season is { } season && group.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes)
                    {
                        if (!_seasons.TryGetValue((show, season), out var seasonMatch))
                        {
                            seasonMatch = resolver.FindInLibrary(new LibraryScope(PlaceholderKinds.Season, show, first.TvdbId, first.ImdbId, season, null), users, group.Kind == PlaceholderKinds.Season ? group.Items.Count : null);
                            _seasons[(show, season)] = seasonMatch;
                        }

                        if (seasonMatch == null || group.Kind == PlaceholderKinds.Season)
                        {
                            return seasonMatch;
                        }
                    }
                }

                return resolver.FindInLibrary(ListSourceGroups.Scope(group), users, group.Kind == PlaceholderKinds.Season ? group.Items.Count : null);
            }
        }
    }

    /// <summary>How fetch and URL failures answer (typed codes; never a title acquisition reason).</summary>
    public static class SourceOutcomes
    {
        /// <summary>The answer to a URL that isn't a supported list (Letterboxd: guidance, nothing fetched).</summary>
        /// <param name="code">Parse error code.</param>
        /// <returns>400 with the code.</returns>
        public static ListOutcome ParseFailure(string? code) => code switch
        {
            ListSourceUrl.LetterboxdUnsupported => ListOutcome.Error(400, code, "Letterboxd doesn't offer an API Jellyfin Enhanced can use. Add the list to MDBList (My Lists → External Lists) and import the MDBList URL, or export the list as CSV on Letterboxd and import the file."),
            ListSourceUrl.InvalidUrl => ListOutcome.Error(400, code, "That isn't a valid list URL."),
            _ => ListOutcome.Error(400, ListSourceUrl.UnsupportedUrl, "Supported list URLs: MDBList, TMDB (lists, collections, charts), Trakt (lists, watchlists, charts), Chronolists watch orders and IMDb (when enabled)."),
        };

        /// <summary>The answer to a failed fetch: its typed code, a status by kind, Retry-After when upstream gave one.</summary>
        /// <param name="result">The failed fetch.</param>
        /// <returns>The outcome.</returns>
        public static ListOutcome FetchFailure(SourceFetchResult result)
        {
            var status = result.ErrorCode switch
            {
                "not_found" or "mdblist_not_public" => 404,
                "rate_limited" or "quota_exhausted" or "fetch_limited" or "read_budget_exhausted" => 429,
                "timeout" => 504,
                "upstream_error" or "unreachable" or "too_large" or "source_empty" or ChronolistsPage.FormatChanged => 502,
                _ => 400, // configuration: provider_disabled, trakt_not_configured, tmdb_key_required, tmdb_key_invalid, imdb_disabled, trakt_unauthorized, provider_pinned
            };
            var outcome = ListOutcome.Error(status, result.ErrorCode ?? "upstream_error", result.Message ?? "The list couldn't be read.");
            return result.RetryAfterSeconds.HasValue ? new ListOutcome { StatusCode = outcome.StatusCode, Value = outcome.Value, RetryAfterSeconds = result.RetryAfterSeconds } : outcome;
        }
    }
}

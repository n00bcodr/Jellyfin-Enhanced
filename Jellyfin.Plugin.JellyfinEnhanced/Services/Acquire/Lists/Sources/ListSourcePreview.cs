using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>
    /// The URL half of the import review (design §8 F1–F6, preview only): reads a list URL through
    /// <see cref="IListSourceFetcher"/> and answers its entries with ids for the review, filtered for restricted callers
    /// (C5) before anything else, then by what the library holds (an entry for a title, season or episode the library has
    /// but the caller can't open is left out, never shown as absent; 4C2-SEC-02). Exact sources (Chronolists) come back
    /// grouped into runs, each entry with all its source keys and a prepared resolution, so no title lookup is needed. The
    /// snapshot describes exactly the keys the reply carries, after every cap and filter (4c2-B3); a caller whose view can
    /// be narrower than the list (parental limits, library access) never gets totals, drops, a digest or a snapshot
    /// (<c>countsHidden</c>, 4C2-SEC-05), whatever left entries out. Nothing here changes a list or stores a link: the
    /// apply and linked sync (track 4c2b) take the same fetch (the fetcher's short cache) and re-check everything.
    /// </summary>
    public sealed class ListSourcePreview
    {
        /// <summary>How long grouping an exact source waits for the season episode counts (shows not answered by then
        /// get no whole-season entries).</summary>
        public static readonly TimeSpan SeasonCountBudget = TimeSpan.FromSeconds(10);

        /// <summary>
        /// How long one preview completes its entries' identities (review round 4, Q-4C2AFIX4-1): lookups run at most
        /// <see cref="MetadataCallLimiter.MaxConcurrent"/> at once, each through the shared limiter; an entry not completed
        /// by then is left out with counts hidden (as a failed lookup), and the lookups it did finish stay cached, so a new
        /// preview goes on from there. Measured (12.2 and 10.11): the limiter's spacing bounds completion at about 10
        /// lookups a second, so 30 s completes a TMDB list of 250-300 entries (one lookup each) in one review, and the
        /// whole request (a large paged read took up to 10 s) stays under a reverse proxy's usual 60 s.
        /// </summary>
        public static readonly TimeSpan DefaultCompletionBudget = TimeSpan.FromSeconds(30);

        private readonly IListSourceFetcher _fetcher;
        private readonly ListImportResolver _resolver;
        private readonly ListAccessService _access;
        private readonly IImportViewerPolicy? _viewer;
        private readonly IImportPhysicalTitles? _physical;
        private readonly Logger _logger;

        /// <summary>Creates the service (DI).</summary>
        /// <param name="fetcher">Source fetcher.</param>
        /// <param name="resolver">Import resolver (library matches, season counts).</param>
        /// <param name="access">Access service (parental checks).</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="viewer">Hidden Content / Spoiler Guard rules of the caller.</param>
        /// <param name="physical">What the library holds of a title for the caller (null: nothing is held anywhere).</param>
        public ListSourcePreview(IListSourceFetcher fetcher, ListImportResolver resolver, ListAccessService access, Logger logger, IImportViewerPolicy? viewer = null, IImportPhysicalTitles? physical = null)
        {
            _fetcher = fetcher;
            _resolver = resolver;
            _access = access;
            _logger = logger;
            _viewer = viewer;
            _physical = physical;
        }

        /// <summary>The identity completion budget of a preview (tests shorten it).</summary>
        internal TimeSpan CompletionBudget { get; set; } = DefaultCompletionBudget;

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
            var hideCounts = HidesCounts(caller);
            if (_access.IsRestricted(caller))
            {
                var (allowed, pending) = await FilterRestrictedAsync(items, caller, cancellationToken).ConfigureAwait(false);
                if (pending)
                {
                    return new ListOutcome { StatusCode = 504, RetryAfterSeconds = 2, Value = new ListErrorDto { Code = "parental_pending", Message = "Checking titles against your parental controls; try again in a moment." } };
                }

                items = allowed;
            }

            // D53 rule 2: every entry's identity is completed once, here; the physical filter, the snapshot keys and the
            // prepared candidates (ids, "in library", Spoiler Guard, placeholder) all take that completed value.
            // SEC-02: a title, season or episode the library holds but the caller can't open is never offered as absent.
            var (held, identities) = await CompleteAndFilterAsync(items, caller, cancellationToken).ConfigureAwait(false);
            hideCounts |= held.Count < items.Count;
            items = held;

            var viewer = _viewer?.For(caller) ?? ImportViewer.None;
            var capped = false;
            if (result.Exact)
            {
                capped = await PrepareGroupedEntriesAsync(response, result.Items, items, identities, libraryUsers ?? new[] { caller }, caller, viewer, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                // Review round 5 (4c2-R5-2): an ordinary entry goes through the viewer's Spoiler Guard like an exact one, on
                // its completed identity (an IMDb episode row carries the episode's title as its note).
                response.Entries = items.Select((item, i) =>
                {
                    var entry = ToEntry(item, i);
                    viewer.Project(entry, identities.GetValueOrDefault(item));
                    return entry;
                }).ToList();
            }

            if (hideCounts)
            {
                // A2 / SEC-05: nothing says how many entries the caller's view left out, wherever they were left out
                // (parental limits, library access, id-less or adult rows): no totals, drops, digest or snapshot.
                response.CountsHidden = true;
                response.Total = 0;
                response.Dropped = 0;
            }
            else
            {
                // B3: the snapshot of what the reply carries, after every cap and filter.
                var represented = result.Exact ? response.SnapshotKeys ?? new List<string>() : response.Entries.Select(e => e.SourceKey).OfType<string>().ToList();
                response.Snapshot = SourceSnapshots.Describe(result, represented, capped);
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

        /// <summary>
        /// True when the caller's view of a list can be narrower than the list itself: Seerr's or Jellyfin's parental
        /// rules, or library access short of every library. Such a caller never gets counts or a snapshot (SEC-05), so the
        /// answer's shape doesn't depend on what was left out.
        /// </summary>
        /// <param name="caller">Caller.</param>
        /// <returns>True when counts are hidden.</returns>
        private bool HidesCounts(User caller) =>
            _access.IsRestricted(caller)
            || ArrJellyfinView.HasParentalLimit(caller)
            || !caller.HasPermission(PermissionKind.EnableAllFolders)
            || caller.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders).Length > 0;

        // D53 rule 2 / SEC-02 / R2-B1: every entry's identity (TMDB, TVDB, IMDb) is completed once through the title lookup
        // when the library holds copies those ids can't find (one completion per identity); an entry whose ids couldn't
        // be completed (the lookup failed) is left out (fails closed). Review round 4 (Q-4C2AFIX4-1): the completions run
        // concurrently, at most the shared limiter's concurrency looking up at once, within CompletionBudget for the whole
        // preview; one not finished by then is left out the same way. Then entries for a title the library holds but the
        // caller can't open (no copy they can open; the season or episode hidden from them) are left out, asked under the
        // completed identity. One read per title and season. Returns the kept entries and their completed identities.
        private async Task<(List<SourceItem> Held, Dictionary<SourceItem, CompletedIdentity> Identities)> CompleteAndFilterAsync(List<SourceItem> items, User caller, CancellationToken cancellationToken)
        {
            var completion = new CompletedIdentity.Completion(_physical, _resolver.Lookup, new ImportCallContext(caller.Id.ToString("N", CultureInfo.InvariantCulture), false), _resolver.Limiter.MaxConcurrent);
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(CompletionBudget);
            var completed = await Task.WhenAll(items.Select(async item =>
            {
                var movie = item.MediaType == "movie";
                try
                {
                    return await completion.CompleteAsync(new ImportIdentity(movie, item.TmdbId, movie ? null : item.TvdbId, item.ImdbId), budget.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    return null; // not completed within the budget
                }
            })).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (budget.IsCancellationRequested && completed.Any(c => c == null))
            {
                _logger.Info($"[Lists] {completed.Count(c => c == null).ToString(CultureInfo.InvariantCulture)} of {items.Count.ToString(CultureInfo.InvariantCulture)} entries' ids weren't completed within {CompletionBudget.TotalSeconds.ToString(CultureInfo.InvariantCulture)} s; they are left out (counts hidden), and a new review goes on from the lookups already made.");
            }

            var projection = _physical == null ? null : new ImportPhysicalProjection(_physical, caller);
            var held = new List<SourceItem>();
            var identities = new Dictionary<SourceItem, CompletedIdentity>(ReferenceEqualityComparer.Instance);
            for (var i = 0; i < items.Count; i++)
            {
                var item = items[i];
                var movie = item.MediaType == "movie";
                if (completed[i] is not { } identity)
                {
                    continue;
                }

                var season = movie ? null : item.Season;
                if (projection == null || !projection.Read(identity, season).Hides(season, item.Episode is int e ? new[] { e } : null))
                {
                    held.Add(item);
                    identities[item] = identity;
                }
            }

            return (held, identities);
        }

        // Exact sources: group the (allowed) entries by their positions in the whole list, prepare each group's
        // resolution and library match, and hand out every key of what is shown as the snapshot. Returns true when the
        // groups were capped (the reply then stands for part of the list only).
        private async Task<bool> PrepareGroupedEntriesAsync(SourceFetchResponse response, IReadOnlyList<SourceItem> all, IReadOnlyList<SourceItem> allowed, IReadOnlyDictionary<SourceItem, CompletedIdentity> identities, IReadOnlyList<User> libraryUsers, User caller, ImportViewer viewer, CancellationToken cancellationToken)
        {
            var (positioned, facts) = Positioned(all, allowed);
            await AddSeasonCountsAsync(facts, positioned, new ImportCallContext(caller.Id.ToString("N", CultureInfo.InvariantCulture), false), cancellationToken).ConfigureAwait(false);
            var groups = ListSourceGroups.Group(positioned, facts);
            var capped = false;
            if (groups.Count > ListStore.MaxPlaceholders)
            {
                groups = groups.Take(ListStore.MaxPlaceholders).ToList();
                response.Truncated = true;
                capped = true;
            }

            var library = new GroupLibrary(_resolver, libraryUsers);
            response.Grouped = true;
            response.Entries = groups.Select((group, i) =>
            {
                var identity = identities[group.First];
                return ListSourceGroups.Entry(group, i, facts, identity, library.Find(group, identity));
            }).ToList();
            for (var i = 0; i < groups.Count; i++)
            {
                viewer.Project(response.Entries[i], identities[groups[i].First]); // the entry's note and its prepared match
            }

            response.SnapshotKeys = groups.SelectMany(g => g.Keys).ToList();
            response.Dropped += positioned.Count < allowed.Count ? allowed.Count - positioned.Count : 0;
            return capped;
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
        /// library, and a run is only looked up when its season is (a run lookup reads the season's episodes). Each is
        /// asked under the group's completed identity.
        /// </summary>
        private sealed class GroupLibrary(ListImportResolver resolver, IReadOnlyList<User> users)
        {
            private readonly Dictionary<string, bool> _shows = new(StringComparer.Ordinal);
            private readonly Dictionary<(string, int), ImportLibraryDto?> _seasons = new();

            public ImportLibraryDto? Find(SourceGroup group, CompletedIdentity identity)
            {
                var first = group.First;
                if (first.MediaType == "tv")
                {
                    var show = identity.Text();
                    if (!_shows.TryGetValue(show, out var present))
                    {
                        present = resolver.FindInLibrary(new LibraryScope(PlaceholderKinds.Series, identity, null, null), users, null) != null;
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
                            seasonMatch = resolver.FindInLibrary(new LibraryScope(PlaceholderKinds.Season, identity, season, null), users, group.Kind == PlaceholderKinds.Season ? group.Items.Count : null);
                            _seasons[(show, season)] = seasonMatch;
                        }

                        if (seasonMatch == null || group.Kind == PlaceholderKinds.Season)
                        {
                            return seasonMatch;
                        }
                    }
                }

                return resolver.FindInLibrary(ListSourceGroups.Scope(group, identity), users, group.Kind == PlaceholderKinds.Season ? group.Items.Count : null);
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
                "upstream_error" or "unreachable" or "too_large" or "source_empty" or ChronolistsPage.FormatChanged or SourceFailures.Redirected or SourceFailures.AddressBlocked => 502,
                _ => 400, // configuration: provider_disabled, trakt_not_configured, tmdb_key_required, tmdb_key_invalid, imdb_disabled, trakt_unauthorized, provider_pinned
            };
            var outcome = ListOutcome.Error(status, result.ErrorCode ?? "upstream_error", result.Message ?? "The list couldn't be read.");
            return result.RetryAfterSeconds.HasValue ? new ListOutcome { StatusCode = outcome.StatusCode, Value = outcome.Value, RetryAfterSeconds = result.RetryAfterSeconds } : outcome;
        }
    }
}

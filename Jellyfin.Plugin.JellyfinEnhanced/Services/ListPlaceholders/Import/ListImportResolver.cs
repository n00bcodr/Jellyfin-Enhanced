using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import
{
    /// <summary>Options of one resolve call.</summary>
    public sealed class ImportResolveOptions
    {
        /// <summary>The caller (parental filter).</summary>
        public required User Caller { get; init; }

        /// <summary>Users that must all see a library match (the caller; for a playlist also its owner).</summary>
        public required IReadOnlyList<User> LibraryUsers { get; init; }

        /// <summary>Limiter owner/priority and the call counter.</summary>
        public required ImportCallContext Context { get; init; }

        /// <summary>Overall deadline; unfinished entries come back transient.</summary>
        public TimeSpan Deadline { get; init; } = ListImportResolver.CallDeadline;

        /// <summary>Filter candidates through the caller's parental controls (off for the sync, whose apply re-checks).</summary>
        public bool Parental { get; init; } = true;

        /// <summary>Pause before retrying a search that came back empty (Seerr hides TMDB errors as empty results).</summary>
        public TimeSpan EmptyRetryDelay { get; init; } = ListImportResolver.DefaultEmptyRetryDelay;
    }

    /// <summary>The result of a resolve call.</summary>
    /// <param name="Response">Per-entry results.</param>
    /// <param name="ParentalPending">The caller's parental checks didn't finish: answer 504 parental_pending + Retry-After.</param>
    public sealed record ImportResolveOutcome(ResolveResponse Response, bool ParentalPending);

    /// <summary>
    /// Resolves parsed import entries to TMDB titles through Seerr (design §7, E1–E5, C5):
    /// <list type="bullet">
    /// <item>explicit ids first (TMDB → details; <c>tmdb:</c>/<c>imdb:</c>/<c>tvdb:</c> search prefixes; IMDb EPISODE ids via
    /// TMDB /find with JE's TMDB key, else "episodeIdUnsupported");</item>
    /// <item>titles: plain search (page 1) first, type filter, normalized-title scoring; a second <c>title year:YYYY</c>
    /// pass only for movie/series lines when the margin is low or the type filter left nothing; an empty search is
    /// retried once (Seerr returns 200-empty on TMDB errors);</item>
    /// <item>season/episode lines never use <c>year:</c>; their top TV candidates are checked against <c>/tv/{id}</c>
    /// (the season must exist, its air year — or the first listed episode's air year — must match the line's year);</item>
    /// <item>"A or B" lines resolve every alternative and always go to review; TBA / in-development lines prefer
    /// undated or future titles and are never auto-accepted;</item>
    /// <item>library matches ("in library") and the parental filter are computed per request, after the shared cache.</item>
    /// </list>
    /// Every Seerr call goes through the shared <see cref="SeerrCallLimiter"/>; the call has a deadline after which the
    /// unfinished entries are returned with state "transient" for the client to resubmit.
    /// </summary>
    public sealed class ListImportResolver
    {
        /// <summary>Entries per /resolve call.</summary>
        public const int MaxEntriesPerCall = 25;

        /// <summary>Concurrent /resolve calls per user (the client sends chunks one after another).</summary>
        public const int MaxConcurrentCallsPerOwner = 2;

        /// <summary>Overall deadline of one /resolve call.</summary>
        public static readonly TimeSpan CallDeadline = TimeSpan.FromSeconds(20);

        /// <summary>Default pause before retrying an empty search.</summary>
        public static readonly TimeSpan DefaultEmptyRetryDelay = TimeSpan.FromMilliseconds(1500);

        /// <summary>Budget for the caller's parental checks.</summary>
        public static readonly TimeSpan ParentalBudget = TimeSpan.FromSeconds(8);

        private const int MaxCandidates = 5;
        private const int MaxAlternatives = 4;
        private const int TvVerifyCount = 3;
        private const int EpisodeVerifyCount = 2;
        private const int ParentalConcurrency = 8;

        private static readonly Regex ImdbRegex = new("^tt[0-9]{5,10}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private readonly IImportLookup _lookup;
        private readonly IListLibraryLookup _library;
        private readonly ListAccessService _access;
        private readonly SeerrCallLimiter _limiter;
        private readonly Logger _logger;
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, int> _activeCalls = new(StringComparer.Ordinal);

        /// <summary>Creates the resolver.</summary>
        /// <param name="lookup">Seerr lookups.</param>
        /// <param name="library">Library lookups (switchable to the phase-3 granularity resolver).</param>
        /// <param name="access">Access service (parental filter).</param>
        /// <param name="limiter">The shared Seerr limiter (its counters go into the log).</param>
        /// <param name="logger">JE logger.</param>
        public ListImportResolver(IImportLookup lookup, IListLibraryLookup library, ListAccessService access, SeerrCallLimiter limiter, Logger logger)
        {
            _lookup = lookup;
            _library = library;
            _access = access;
            _limiter = limiter;
            _logger = logger;
        }

        /// <summary>True when Seerr is enabled and configured.</summary>
        public bool IsAvailable => _lookup.IsConfigured;

        /// <summary>
        /// Admits one interactive /resolve call of <paramref name="owner"/> (at most <see cref="MaxConcurrentCallsPerOwner"/>
        /// at a time), so one user can't queue unbounded Seerr work. Dispose the result when the call is done.
        /// </summary>
        /// <param name="owner">User id.</param>
        /// <returns>The admission, or null when the user already has that many calls running.</returns>
        public IDisposable? TryEnterCall(string owner)
        {
            while (true)
            {
                var current = _activeCalls.GetOrAdd(owner, 0);
                if (current >= MaxConcurrentCallsPerOwner)
                {
                    return null;
                }

                if (_activeCalls.TryUpdate(owner, current + 1, current))
                {
                    return new CallAdmission(this, owner);
                }
            }
        }

        private void ExitCall(string owner)
        {
            while (true)
            {
                var current = _activeCalls.GetOrAdd(owner, 1);
                if (current <= 1)
                {
                    if (_activeCalls.TryRemove(new System.Collections.Generic.KeyValuePair<string, int>(owner, current)))
                    {
                        return;
                    }
                }
                else if (_activeCalls.TryUpdate(owner, current - 1, current))
                {
                    return;
                }
            }
        }

        /// <summary>Resolves up to <see cref="MaxEntriesPerCall"/> entries (callers chunk).</summary>
        /// <param name="entries">Entries.</param>
        /// <param name="options">Options.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns>The outcome.</returns>
        public async Task<ImportResolveOutcome> ResolveAsync(IReadOnlyList<ImportEntryDto> entries, ImportResolveOptions options, CancellationToken cancellationToken)
        {
            var clock = Stopwatch.StartNew();
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(options.Deadline);
            var tasks = entries.Select((entry, i) => RunOneAsync(entry, i, options, deadline.Token, cancellationToken)).ToList();
            var results = await Task.WhenAll(tasks).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();

            var response = new ResolveResponse
            {
                Results = results.ToList(),
                Complete = results.All(r => r.State != "transient"),
                SeerrCalls = options.Context.Calls,
            };

            var pending = false;
            if (options.Parental && _access.IsRestricted(options.Caller))
            {
                pending = await FilterParentalAsync(response.Results, options.Caller, cancellationToken).ConfigureAwait(false);
            }

            var (total, peak, perSecond) = _limiter.Stats();
            _logger.Info($"[ListPlaceholders] Resolved {entries.Count} import entries for {options.Context.Owner} in {clock.ElapsedMilliseconds} ms: "
                + $"{response.Results.Count(r => r.Confidence == ImportScoring.Levels.High)} high, {response.Results.Count(r => r.State == "transient")} transient, {options.Context.Calls} Seerr calls "
                + $"(limiter since start: {total} calls, peak {peak} concurrent, at most {perSecond} started in any second).");
            return new ImportResolveOutcome(response, pending);
        }

        private async Task<ResolvedEntryDto> RunOneAsync(ImportEntryDto entry, int position, ImportResolveOptions options, CancellationToken deadline, CancellationToken aborted)
        {
            var index = entry?.Index is >= 0 ? entry.Index.Value : position;
            var wanted = Validate(entry);
            if (wanted == null)
            {
                return new ResolvedEntryDto { Index = index, State = "invalid", Reasons = new List<string> { "invalid" } };
            }

            try
            {
                return await ResolveEntryAsync(wanted, index, options, deadline).ConfigureAwait(false);
            }
            catch (TransientLookupException)
            {
                return Transient(index, wanted);
            }
            catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
            {
                return Transient(index, wanted);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One odd upstream answer must not fail the other 24 entries: report it as retryable.
                _logger.Warning($"[ListPlaceholders] Resolving import entry {index} failed: {ex.Message}");
                return Transient(index, wanted);
            }
        }

        private static ResolvedEntryDto Transient(int index, Wanted wanted) =>
            new() { Index = index, State = "transient", Kind = wanted.Kind, Alternatives = wanted.Alternatives.Count > 1 };

        private async Task<ResolvedEntryDto> ResolveEntryAsync(Wanted wanted, int index, ImportResolveOptions options, CancellationToken cancellationToken)
        {
            var result = new ResolvedEntryDto { Index = index, Kind = wanted.Kind };
            var reasons = new SortedSet<string>(StringComparer.Ordinal);
            List<Scored> ordered;
            Wanted effective = wanted;
            string confidence;

            if (wanted.Alternatives.Count > 1)
            {
                result.Alternatives = true;
                reasons.Add("alternatives");
                var perAlternative = await Task.WhenAll(wanted.Alternatives.Select(async (alternative, i) =>
                {
                    var (list, _, resolvedAlternative) = await CandidatesAsync(alternative, options, reasons, cancellationToken).ConfigureAwait(false);
                    foreach (var candidate in list)
                    {
                        // Each candidate keeps the alternative it answers (its own kind, season and episodes).
                        candidate.Alternative = i;
                        candidate.For = resolvedAlternative;
                    }

                    return list;
                })).ConfigureAwait(false);

                // Interleave the best of each alternative so both choices are on top.
                ordered = new List<Scored>();
                for (var rank = 0; rank < MaxCandidates && ordered.Count < MaxCandidates; rank++)
                {
                    foreach (var list in perAlternative)
                    {
                        if (rank < list.Count && ordered.Count < MaxCandidates)
                        {
                            ordered.Add(list[rank]);
                        }
                    }
                }

                confidence = ordered.Count > 0 ? ImportScoring.Levels.Low : ImportScoring.Levels.None;
            }
            else
            {
                var (list, explicitId, resolved) = await CandidatesAsync(wanted, options, reasons, cancellationToken).ConfigureAwait(false);
                effective = resolved;
                result.Kind = effective.Kind;
                ordered = list.Take(MaxCandidates).ToList();
                confidence = Confidence(effective, ordered, explicitId, reasons);
            }

            if (ordered.Count == 0)
            {
                reasons.Add("noMatch");
            }

            var top = ordered.FirstOrDefault();
            if (top != null && top.Hit.MediaType == "tv" && (top.For ?? effective).Kind != PlaceholderKinds.Movie)
            {
                await EnrichTvAsync(top, top.For ?? effective, options.Context, cancellationToken).ConfigureAwait(false);
            }

            result.Candidates = ordered.Select(c => ToDto(c, c.For ?? effective, options.LibraryUsers)).ToList();
            result.Match = result.Candidates.FirstOrDefault();
            result.Confidence = confidence;
            result.Reasons = reasons.ToList();
            return result;
        }

        // ── Candidates ──────────────────────────────────────────────────────

        private async Task<(List<Scored> Candidates, bool ExplicitId, Wanted Effective)> CandidatesAsync(Wanted wanted, ImportResolveOptions options, ISet<string> reasons, CancellationToken cancellationToken)
        {
            var context = options.Context;
            var list = new List<Scored>();
            var explicitId = false;
            var effective = wanted;

            if (wanted.TmdbId.HasValue)
            {
                explicitId = true;
                var type = wanted.TmdbType ?? wanted.TypeHint ?? (wanted.Kind is PlaceholderKinds.Series or PlaceholderKinds.Season or PlaceholderKinds.Episodes ? "tv" : null);
                if (type != null)
                {
                    var details = Require(await _lookup.GetDetailsAsync(type, wanted.TmdbId.Value, context, cancellationToken).ConfigureAwait(false));
                    if (details != null)
                    {
                        list.Add(new Scored(details.Hit, ImportScoring.ExplicitIdScore, true) { Details = details });
                    }
                }
                else
                {
                    var hits = Require(await _lookup.SearchAsync("tmdb:" + wanted.TmdbId.Value.ToString(CultureInfo.InvariantCulture), context, cancellationToken).ConfigureAwait(false)) ?? Array.Empty<TitleHit>();
                    list.AddRange(hits.Where(h => h.TmdbId == wanted.TmdbId.Value).Select(h => new Scored(h, ImportScoring.ExplicitIdScore, true)));
                }
            }
            else if (wanted.ImdbId != null)
            {
                explicitId = true;
                if (wanted.ImdbEpisode)
                {
                    if (!_lookup.CanFindImdbEpisodes)
                    {
                        reasons.Add("episodeIdUnsupported");
                    }
                    else
                    {
                        var found = Require(await _lookup.FindImdbEpisodeAsync(wanted.ImdbId, cancellationToken).ConfigureAwait(false));
                        if (found != null)
                        {
                            var details = Require(await _lookup.GetDetailsAsync("tv", found.ShowTmdbId, context, cancellationToken).ConfigureAwait(false));
                            if (details != null)
                            {
                                effective = wanted with { Season = found.Season, Episodes = new[] { found.Episode }, TypeHint = "tv", EpisodeTitle = null };
                                list.Add(new Scored(details.Hit, ImportScoring.ExplicitIdScore, true) { Details = details });
                            }
                        }
                    }
                }
                else
                {
                    var hits = Require(await _lookup.SearchAsync("imdb:" + wanted.ImdbId, context, cancellationToken).ConfigureAwait(false)) ?? Array.Empty<TitleHit>();
                    var typed = hits.Where(h => MatchesType(h, wanted)).ToList();
                    list.AddRange((typed.Count > 0 ? typed : hits.ToList()).Select(h => new Scored(h, ImportScoring.ExplicitIdScore, true)));
                }
            }
            else if (wanted.TvdbId.HasValue)
            {
                explicitId = true;
                var hits = Require(await _lookup.SearchAsync("tvdb:" + wanted.TvdbId.Value.ToString(CultureInfo.InvariantCulture), context, cancellationToken).ConfigureAwait(false)) ?? Array.Empty<TitleHit>();
                list.AddRange(hits.Where(h => h.MediaType == "tv").Select(h => new Scored(h, ImportScoring.ExplicitIdScore, true)));
            }

            // An IMDb episode row's title is the EPISODE title: searching it would only find unrelated titles.
            if (list.Count == 0 && wanted.Title.Length > 0 && !wanted.ImdbEpisode)
            {
                explicitId = false;
                list = await TitleCandidatesAsync(effective, options, reasons, cancellationToken).ConfigureAwait(false);
            }
            else if (list.Count == 0)
            {
                reasons.Add("notFound");
            }

            if (effective.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && effective.Season.HasValue && list.Any(c => c.Hit.MediaType == "tv"))
            {
                await VerifySeasonAsync(effective, list, context, cancellationToken).ConfigureAwait(false);
            }

            if (effective.Status == "tba")
            {
                var lastYear = DateTime.UtcNow.Year - 1;
                foreach (var candidate in list.Where(c => !c.Explicit))
                {
                    // In development / TBA: an old release is most likely a different title with the same name.
                    candidate.Score += candidate.Hit.Year is int year ? (year < lastYear ? -40 : 10) : 10;
                }
            }

            return (list.OrderByDescending(c => c.Score).ThenByDescending(c => c.Hit.Popularity).ToList(), explicitId, effective);
        }

        private async Task<List<Scored>> TitleCandidatesAsync(Wanted wanted, ImportResolveOptions options, ISet<string> reasons, CancellationToken cancellationToken)
        {
            var context = options.Context;
            // The year of a season/episode line is the season's air year: never a search filter (E1).
            var useYear = wanted.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes ? null : wanted.Year;
            var hits = await SearchWithRetryAsync(wanted.Title, options, cancellationToken).ConfigureAwait(false);
            var scored = hits.Where(h => MatchesType(h, wanted)).Select(h => Score(h, wanted.Title, useYear)).ToList();

            // Second pass only when the plain search didn't already settle it (no typed hit, weak top or small margin).
            if (useYear.HasValue && (scored.Count == 0 || scored.Max(c => c.Score) < ImportScoring.HighScore || Margin(scored) < ImportScoring.HighMargin))
            {
                var more = Require(await _lookup.SearchAsync(wanted.Title + " year:" + useYear.Value.ToString(CultureInfo.InvariantCulture), context, cancellationToken).ConfigureAwait(false)) ?? Array.Empty<TitleHit>();
                foreach (var hit in more.Where(h => MatchesType(h, wanted)))
                {
                    if (!scored.Any(c => c.Hit.MediaType == hit.MediaType && c.Hit.TmdbId == hit.TmdbId))
                    {
                        scored.Add(Score(hit, wanted.Title, useYear));
                    }
                }

                hits = hits.Concat(more).ToList();
            }

            if (scored.Count == 0 && hits.Count > 0 && ExpectedType(wanted) != null)
            {
                // Wrong type everywhere: offer the other type's titles for review instead of nothing.
                reasons.Add("typeMismatch");
                scored = hits.Where(h => h.MediaType is "movie" or "tv")
                    .GroupBy(h => h.MediaType + "|" + h.TmdbId.ToString(CultureInfo.InvariantCulture)).Select(g => g.First())
                    .Select(h => { var s = Score(h, wanted.Title, useYear); s.Score -= 30; return s; })
                    .ToList();
            }

            return scored;
        }

        private async Task<IReadOnlyList<TitleHit>> SearchWithRetryAsync(string query, ImportResolveOptions options, CancellationToken cancellationToken)
        {
            var hits = Require(await _lookup.SearchAsync(query, options.Context, cancellationToken).ConfigureAwait(false)) ?? Array.Empty<TitleHit>();
            if (hits.Count == 0)
            {
                // Seerr answers a TMDB error (incl. 429) with 200 and no results: retry once before believing it.
                await Task.Delay(options.EmptyRetryDelay, cancellationToken).ConfigureAwait(false);
                hits = Require(await _lookup.SearchAsync(query, options.Context, cancellationToken).ConfigureAwait(false)) ?? Array.Empty<TitleHit>();
            }

            return hits;
        }

        private async Task VerifySeasonAsync(Wanted wanted, List<Scored> list, ImportCallContext context, CancellationToken cancellationToken)
        {
            var season = wanted.Season!.Value;
            // A season/episode line names a show: movie candidates only stay when no show matched at all.
            list.RemoveAll(c => c.Hit.MediaType != "tv");
            var verify = list.OrderByDescending(c => c.Score).Take(TvVerifyCount).ToList();
            foreach (var unverified in list.Except(verify))
            {
                unverified.Score -= 20;
            }

            var details = await Task.WhenAll(verify.Select(c => c.Details != null
                ? Task.FromResult(new LookupResult<TitleDetails>(LookupStatus.Ok, c.Details))
                : _lookup.GetDetailsAsync("tv", c.Hit.TmdbId, context, cancellationToken))).ConfigureAwait(false);
            for (var i = 0; i < verify.Count; i++)
            {
                var candidate = verify[i];
                if (details[i].Status == LookupStatus.Transient)
                {
                    if (i == 0)
                    {
                        throw new TransientLookupException();
                    }

                    candidate.Score -= 20;
                    continue;
                }

                candidate.Details = details[i].Value ?? candidate.Details;
                var facts = candidate.Details?.Seasons.FirstOrDefault(s => s.SeasonNumber == season);
                if (facts == null)
                {
                    candidate.SeasonMissing = true;
                    candidate.Score -= 60;
                    continue;
                }

                candidate.Season = facts;
                if (wanted.Kind == PlaceholderKinds.Season)
                {
                    candidate.Score += ImportScoring.YearScore(YearOf(facts.AirDate), wanted.Year);
                }
            }

            if (wanted.Kind != PlaceholderKinds.Episodes || wanted.Episodes.Count == 0)
            {
                return;
            }

            var withSeason = verify.Where(c => !c.SeasonMissing && c.Season != null).OrderByDescending(c => c.Score).Take(EpisodeVerifyCount).ToList();
            var seasons = await Task.WhenAll(withSeason.Select(c => _lookup.GetSeasonAsync(c.Hit.TmdbId, season, context, cancellationToken))).ConfigureAwait(false);
            for (var i = 0; i < withSeason.Count; i++)
            {
                var candidate = withSeason[i];
                if (seasons[i].Status == LookupStatus.Transient)
                {
                    if (i == 0)
                    {
                        throw new TransientLookupException();
                    }

                    continue;
                }

                if (seasons[i].Status == LookupStatus.NotFound)
                {
                    candidate.SeasonMissing = true;
                    candidate.Score -= 60;
                    continue;
                }

                var byNumber = seasons[i].Value!.GroupBy(e => e.Episode).ToDictionary(g => g.Key, g => g.First());
                candidate.Episodes = wanted.Episodes.Where(byNumber.ContainsKey).Select(e => byNumber[e]).ToList();
                if (candidate.Episodes.Count < wanted.Episodes.Count)
                {
                    candidate.EpisodeMissing = true;
                    candidate.Score -= 60;
                }
                else if (wanted.OpenEnded)
                {
                    // "S1E5–S3E3": season 1 runs from episode 5 to its last episode.
                    var first = wanted.Episodes[0];
                    candidate.Episodes = byNumber.Keys.Where(e => e >= first).OrderBy(e => e).Take(PlaceholderRules.MaxEpisodes).Select(e => byNumber[e]).ToList();
                }

                var airYear = YearOf(candidate.Episodes.FirstOrDefault()?.AirDate) ?? YearOf(candidate.Season?.AirDate);
                candidate.Score += ImportScoring.YearScore(airYear, wanted.Year);
            }
        }

        private async Task EnrichTvAsync(Scored top, Wanted wanted, ImportCallContext context, CancellationToken cancellationToken)
        {
            if (top.Details == null)
            {
                var details = await _lookup.GetDetailsAsync("tv", top.Hit.TmdbId, context, cancellationToken).ConfigureAwait(false);
                if (details.Status == LookupStatus.Ok)
                {
                    top.Details = details.Value;
                }
            }

            if (top.Details != null && wanted.Season.HasValue && top.Season == null)
            {
                top.Season = top.Details.Seasons.FirstOrDefault(s => s.SeasonNumber == wanted.Season.Value);
            }
        }

        // ── Confidence ──────────────────────────────────────────────────────

        private static string Confidence(Wanted wanted, List<Scored> ordered, bool explicitId, ISet<string> reasons)
        {
            var top = ordered.FirstOrDefault();
            if (top == null)
            {
                return ImportScoring.Levels.None;
            }

            var second = ordered.Skip(1).FirstOrDefault();
            string level;
            if (explicitId)
            {
                level = second == null || top.Score - second.Score >= 1 ? ImportScoring.Levels.High : ImportScoring.Levels.Low;
                if (level == ImportScoring.Levels.Low)
                {
                    reasons.Add("tie");
                }
            }
            else
            {
                var exactTie = second != null && top.Exact && second.Exact && top.Score - second.Score < 10;
                level = ImportScoring.Confidence(top.Score, second?.Score, exactTie, wanted.Year.HasValue);
                if (exactTie)
                {
                    reasons.Add("tie");
                }
                else if (!wanted.Year.HasValue && ImportScoring.Confidence(top.Score, second?.Score, false, true) == ImportScoring.Levels.High)
                {
                    reasons.Add("noYear");
                }
                else if (level == ImportScoring.Levels.Low)
                {
                    reasons.Add(top.Score < ImportScoring.MediumScore ? "lowScore" : "closeMatch");
                }

                // Same-name titles nobody means (an obscure namesake) only cost one click, not a full review.
                // Never for ties between exact matches (E2: those always need a review).
                if (level == ImportScoring.Levels.Low && !exactTie && top.Score >= ImportScoring.MediumScore && second != null
                    && ImportScoring.Dominates(top.Hit.VoteCount, second.Hit.VoteCount))
                {
                    level = ImportScoring.Levels.Medium;
                }
            }

            void CapLow(bool condition, string reason)
            {
                if (condition)
                {
                    reasons.Add(reason);
                    level = ImportScoring.Cap(level, ImportScoring.Levels.Low);
                }
            }

            CapLow(wanted.Status == "tba", "tba");
            CapLow(top.SeasonMissing, "seasonMissing");
            CapLow(top.EpisodeMissing, "episodeMissing");
            CapLow(wanted.EpisodeTitle != null, "episodeByTitle");
            CapLow(wanted.OpenEnded && top.Episodes == null, "openEnded"); // the rest of the season couldn't be read
            return level;
        }

        // ── Output ──────────────────────────────────────────────────────────

        private ImportCandidateDto ToDto(Scored candidate, Wanted wanted, IReadOnlyList<User> libraryUsers)
        {
            var hit = candidate.Hit;
            var dto = new ImportCandidateDto
            {
                MediaType = hit.MediaType,
                TmdbId = hit.TmdbId,
                Title = hit.Title,
                Year = hit.Year,
                ReleaseDate = hit.ReleaseDate,
                PosterPath = hit.PosterPath,
                Overview = hit.Overview,
                Score = Math.Round(candidate.Score, 1),
                TvdbId = candidate.Details?.TvdbId,
                ImdbId = candidate.Details?.ImdbId,
                Alternative = candidate.Alternative,
            };

            var kind = hit.MediaType == "movie" ? PlaceholderKinds.Movie : wanted.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes ? wanted.Kind : PlaceholderKinds.Series;
            if (hit.MediaType == "tv")
            {
                if (candidate.Season != null)
                {
                    dto.Season = new ImportSeasonDto { SeasonNumber = candidate.Season.SeasonNumber, EpisodeCount = candidate.Season.EpisodeCount, AirDate = candidate.Season.AirDate, Name = candidate.Season.Name };
                }

                if (candidate.Episodes != null)
                {
                    dto.Episodes = candidate.Episodes.Select(e => new ImportEpisodeInfoDto { S = e.Season, E = e.Episode, Title = e.Title, AirDate = e.AirDate }).ToList();
                }

                dto.EpisodeTotal = kind switch
                {
                    PlaceholderKinds.Season => candidate.Season?.EpisodeCount,
                    PlaceholderKinds.Series => candidate.Details?.Seasons.Where(s => s.SeasonNumber > 0).Sum(s => s.EpisodeCount ?? 0) is int total and > 0 ? total : null,
                    _ => null,
                };
            }

            if (wanted.EpisodeTitle != null && wanted.Episodes.Count == 0)
            {
                return dto; // the episode itself is unknown: nothing to look for in the library yet
            }

            try
            {
                var episodes = wanted.OpenEnded && candidate.Episodes is { Count: > 0 } ? candidate.Episodes.Select(e => e.Episode).ToList() : wanted.Episodes;
                var scope = new LibraryScope(kind, hit.TmdbId, dto.TvdbId, dto.ImdbId, kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes ? wanted.Season : null, kind == PlaceholderKinds.Episodes ? episodes : null);
                var match = _library.Find(scope, libraryUsers, dto.EpisodeTotal);
                if (match != null)
                {
                    dto.InLibrary = new ImportLibraryDto
                    {
                        ItemId = match.ItemId.ToString("N", CultureInfo.InvariantCulture),
                        Kind = match.Kind,
                        EpisodeItemIds = match.EpisodeIds.Count > 0 ? match.EpisodeIds.Select(id => id.ToString("N", CultureInfo.InvariantCulture)).ToList() : null,
                        Complete = match.Complete,
                    };
                }
            }
            catch (Exception ex)
            {
                _logger.Debug($"[ListPlaceholders] Library lookup for {hit.MediaType} {hit.TmdbId} failed: {ex.Message}");
            }

            return dto;
        }

        // C5: restricted callers never see blocked or unverifiable candidates. Returns true when checks are pending.
        private async Task<bool> FilterParentalAsync(List<ResolvedEntryDto> results, User caller, CancellationToken cancellationToken)
        {
            var keys = results.SelectMany(r => r.Candidates).Select(c => (c.MediaType, c.TmdbId)).Distinct().ToList();
            var blocked = new HashSet<(string, int)>();
            var pending = false;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(ParentalBudget);
            using var gate = new SemaphoreSlim(ParentalConcurrency);
            await Task.WhenAll(keys.Select(async key =>
            {
                try
                {
                    await gate.WaitAsync(budget.Token).ConfigureAwait(false);
                    try
                    {
                        if (await _access.IsTitleBlockedAsync(key.MediaType, key.TmdbId, caller, budget.Token).ConfigureAwait(false))
                        {
                            lock (blocked)
                            {
                                blocked.Add(key);
                            }
                        }
                    }
                    finally
                    {
                        gate.Release();
                    }
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    pending = true;
                    lock (blocked)
                    {
                        blocked.Add(key);
                    }
                }
            })).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();

            foreach (var result in results)
            {
                var before = result.Match;
                result.Candidates = result.Candidates.Where(c => !blocked.Contains((c.MediaType, c.TmdbId))).ToList();
                result.Match = result.Candidates.FirstOrDefault();
                if (result.Match == null && before != null)
                {
                    result.Confidence = ImportScoring.Levels.None;
                    result.Reasons = result.Reasons.Where(r => r != "noMatch").Append("noMatch").ToList();
                }
                else if (!ReferenceEquals(before, result.Match))
                {
                    result.Confidence = ImportScoring.Cap(result.Confidence, ImportScoring.Levels.Low);
                }
            }

            return pending;
        }

        // ── Helpers ─────────────────────────────────────────────────────────

        private static T? Require<T>(LookupResult<T> result) =>
            result.Status == LookupStatus.Transient ? throw new TransientLookupException() : result.Value;

        private static Scored Score(TitleHit hit, string title, int? year)
        {
            var (titleScore, exact) = ImportScoring.TitleScore(hit.Title, hit.OriginalTitle, title);
            var score = titleScore + ImportScoring.YearScore(hit.Year, year) + ImportScoring.Tiebreak(hit.VoteCount, hit.Popularity);
            return new Scored(hit, score, false) { Exact = exact };
        }

        private static double Margin(List<Scored> scored)
        {
            var ordered = scored.Select(s => s.Score).OrderByDescending(s => s).ToList();
            return ordered.Count switch
            {
                0 => 0,
                1 => ordered[0],
                _ => ordered[0] - ordered[1],
            };
        }

        private static string? ExpectedType(Wanted wanted) => wanted.TypeHint
            ?? (wanted.Kind is PlaceholderKinds.Series or PlaceholderKinds.Season or PlaceholderKinds.Episodes ? "tv" : wanted.Kind == PlaceholderKinds.Movie ? "movie" : null);

        private static bool MatchesType(TitleHit hit, Wanted wanted)
        {
            var type = ExpectedType(wanted);
            return hit.MediaType is "movie" or "tv" && (type == null || hit.MediaType == type);
        }

        private static int? YearOf(string? date) =>
            date != null && date.Length >= 4 && int.TryParse(date.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var year) ? year : null;

        /// <summary>Validates and normalises one client entry (null = invalid).</summary>
        /// <param name="entry">Client entry.</param>
        /// <returns>The normalised entry, or null.</returns>
        internal static Wanted? Validate(ImportEntryDto? entry)
        {
            if (entry == null)
            {
                return null;
            }

            var main = ValidateCore(entry.Title, entry.Year, entry.TypeHint, entry.Season, entry.Episodes, entry.EpisodeTitle, entry.Ids, entry.ImdbEpisode == true, entry.Status);
            if (main == null)
            {
                return null;
            }

            if (entry.OpenEnded == true && main.Episodes.Count > 0)
            {
                main = main with { OpenEnded = true };
            }

            if (entry.Alternatives is { Count: > 1 })
            {
                if (entry.Alternatives.Count > MaxAlternatives)
                {
                    return null;
                }

                var alternatives = new List<Wanted>();
                foreach (var alternative in entry.Alternatives)
                {
                    // An alternative names its own season (the parser sends it per alternative): "Show A Season 2 or Show B"
                    // means Show B as a whole. Listed episodes only carry over to an alternative of the same season.
                    var sameSeason = alternative?.Season != null && alternative.Season == (entry.Season ?? entry.Episodes?.FirstOrDefault()?.S);
                    var parsed = alternative == null ? null : ValidateCore(alternative.Title, alternative.Year, alternative.TypeHint ?? entry.TypeHint, alternative.Season, sameSeason ? entry.Episodes : null, null, alternative.Ids, false, entry.Status);
                    if (parsed == null)
                    {
                        return null;
                    }

                    alternatives.Add(parsed);
                }

                main = main with { Alternatives = alternatives };
            }

            return main;
        }

        private static Wanted? ValidateCore(string? rawTitle, int? year, string? typeHint, int? season, List<ImportEpisodeDto>? episodes, string? episodeTitle, ImportIdsDto? ids, bool imdbEpisode, string? status)
        {
            var title = PlaceholderRules.CleanText(rawTitle);
            if (title.Length > PlaceholderRules.MaxTitle)
            {
                return null;
            }

            int? tmdb = ids?.Tmdb is > 0 and < 1_000_000_000 ? ids.Tmdb : null;
            var tmdbType = ids?.TmdbType is "movie" or "tv" ? ids.TmdbType : null;
            var imdb = ids?.Imdb != null && ImdbRegex.IsMatch(ids.Imdb.Trim()) ? ids.Imdb.Trim() : null;
            int? tvdb = ids?.Tvdb is > 0 and < 1_000_000_000 ? ids.Tvdb : null;
            if (title.Length == 0 && tmdb == null && imdb == null && tvdb == null)
            {
                return null;
            }

            if (season.HasValue && (season < 0 || season > 200))
            {
                return null;
            }

            var numbers = new List<int>();
            if (episodes is { Count: > 0 })
            {
                if (episodes.Count > PlaceholderRules.MaxEpisodes)
                {
                    return null;
                }

                season ??= episodes[0]?.S;
                foreach (var episode in episodes)
                {
                    // C2: one entry, one season.
                    if (episode == null || episode.S != season || episode.E < 0 || episode.E > 9999)
                    {
                        return null;
                    }

                    if (!numbers.Contains(episode.E))
                    {
                        numbers.Add(episode.E);
                    }
                }

                if (season is < 0 or > 200)
                {
                    return null;
                }
            }

            var cleanEpisodeTitle = PlaceholderRules.CleanText(episodeTitle);
            return new Wanted(
                title,
                year is >= 1870 and <= 2100 ? year : null,
                typeHint is "movie" or "tv" ? typeHint : null,
                season,
                numbers.OrderBy(n => n).ToList(),
                cleanEpisodeTitle.Length == 0 ? null : (cleanEpisodeTitle.Length > PlaceholderRules.MaxTitle ? cleanEpisodeTitle[..PlaceholderRules.MaxTitle] : cleanEpisodeTitle),
                tmdb,
                tmdbType,
                imdb,
                tvdb,
                imdbEpisode && imdb != null,
                status is "released" or "scheduled" or "tba" ? status : null,
                Array.Empty<Wanted>());
        }

        /// <summary>A validated import entry.</summary>
        /// <param name="Title">Clean title (may be empty with ids).</param>
        /// <param name="Year">Year.</param>
        /// <param name="TypeHint">movie | tv.</param>
        /// <param name="Season">Season.</param>
        /// <param name="Episodes">Episode numbers of <paramref name="Season"/>.</param>
        /// <param name="EpisodeTitle">Episode named by title.</param>
        /// <param name="TmdbId">TMDB id.</param>
        /// <param name="TmdbType">TMDB id type.</param>
        /// <param name="ImdbId">IMDb id.</param>
        /// <param name="TvdbId">TVDB id.</param>
        /// <param name="ImdbEpisode">The IMDb id names an episode.</param>
        /// <param name="Status">released | scheduled | tba.</param>
        /// <param name="Alternatives">"A or B" alternatives.</param>
        /// <param name="OpenEnded">The first episode starts a range to the end of the season.</param>
        internal sealed record Wanted(
            string Title,
            int? Year,
            string? TypeHint,
            int? Season,
            IReadOnlyList<int> Episodes,
            string? EpisodeTitle,
            int? TmdbId,
            string? TmdbType,
            string? ImdbId,
            int? TvdbId,
            bool ImdbEpisode,
            string? Status,
            IReadOnlyList<Wanted> Alternatives,
            bool OpenEnded = false)
        {
            /// <summary>The granularity the entry asks for (null = unknown: decided by the match).</summary>
            public string? Kind => Episodes.Count > 0 || EpisodeTitle != null || ImdbEpisode ? PlaceholderKinds.Episodes
                : Season.HasValue ? PlaceholderKinds.Season
                : TypeHint == "tv" || TmdbType == "tv" ? PlaceholderKinds.Series
                : TypeHint == "movie" || TmdbType == "movie" ? PlaceholderKinds.Movie
                : null;
        }

        private sealed class Scored(TitleHit hit, double score, bool isExplicit)
        {
            public TitleHit Hit { get; } = hit;

            public double Score { get; set; } = score;

            public bool Explicit { get; } = isExplicit;

            public bool Exact { get; init; }

            public int? Alternative { get; set; }

            // The (resolved) alternative this candidate answers; null = the entry itself.
            public Wanted? For { get; set; }

            public TitleDetails? Details { get; set; }

            public SeasonFacts? Season { get; set; }

            public List<EpisodeFacts>? Episodes { get; set; }

            public bool SeasonMissing { get; set; }

            public bool EpisodeMissing { get; set; }
        }

        private sealed class TransientLookupException : Exception
        {
        }

        private sealed class CallAdmission(ListImportResolver owner, string key) : IDisposable
        {
            private ListImportResolver? _owner = owner;

            public void Dispose() => Interlocked.Exchange(ref _owner, null)?.ExitCall(key);
        }
    }
}

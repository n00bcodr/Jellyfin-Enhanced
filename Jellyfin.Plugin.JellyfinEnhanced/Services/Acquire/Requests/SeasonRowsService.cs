using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>One episode of a season as the season page's request controls see it.</summary>
    public sealed record SeasonRowEpisode
    {
        /// <summary>Episode number.</summary>
        [JsonPropertyName("episode")] public int Episode { get; init; }

        /// <summary>Episode title (only for episodes with no file in Jellyfin).</summary>
        [JsonPropertyName("title")] public string? Title { get; init; }

        /// <summary>Plain-text overview (only for episodes with no file in Jellyfin).</summary>
        [JsonPropertyName("overview")] public string? Overview { get; init; }

        /// <summary>Runtime in minutes.</summary>
        [JsonPropertyName("runtime")] public int? Runtime { get; init; }

        /// <summary>Air date as a calendar day (yyyy-MM-dd).</summary>
        [JsonPropertyName("airDate")] public string? AirDate { get; init; }

        /// <summary>TMDB still path ("/abc.jpg"), validated; the client builds the image URL.</summary>
        [JsonPropertyName("still")] public string? Still { get; init; }

        /// <summary>
        /// The viewer's request state of this episode: waiting (their ask waits for an OK), asked (their
        /// ask is on its way), declined (their ask was declined), household (someone else asked), or null.
        /// </summary>
        [JsonPropertyName("request")] public string? Request { get; init; }

        /// <summary>
        /// The same for the 4K edition (D53, edition round 19: a control reads the request states of its own binding's edition
        /// and destination): a 4K copy's Get it reads this, never the standard asks.
        /// </summary>
        [JsonPropertyName("request4k")] public string? Request4k { get; init; }
    }

    /// <summary>The season answer: request state and metadata of the episodes Jellyfin has no file for.</summary>
    public sealed record SeasonRows
    {
        /// <summary>Season title key.</summary>
        [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;

        /// <summary>Series title key (what a request names).</summary>
        [JsonPropertyName("series")] public string Series { get; init; } = string.Empty;

        /// <summary>Season number.</summary>
        [JsonPropertyName("season")] public int Season { get; init; }

        /// <summary>The Jellyfin series item (the viewer can open it).</summary>
        [JsonPropertyName("seriesId")] public string SeriesId { get; init; } = string.Empty;

        /// <summary>
        /// The viewer shows missing episodes within seasons (Jellyfin's per-user display setting): the
        /// season page then lists missing episodes as rows; otherwise a banner names them.
        /// </summary>
        [JsonPropertyName("displayMissing")] public bool DisplayMissing { get; init; }

        /// <summary>The viewer may ask for episodes of this series (role, library, rating and backend).</summary>
        [JsonPropertyName("canRequest")] public bool CanRequest { get; init; }

        /// <summary>
        /// Why the viewer can't ask for episodes of this series right now although their role may (for example
        /// <c>low_disk</c>, "Paused: storage full"), shown in place of Get it; null when they can, or can't anyway.
        /// </summary>
        [JsonPropertyName("blocked")] public RequestBlock? Blocked { get; init; }

        /// <summary>The viewer's request state of the whole season (same values as an episode's).</summary>
        [JsonPropertyName("seasonRequest")] public string? SeasonRequest { get; init; }

        /// <summary>The viewer may ask for this series in 4K now (the 4K edition's own policy probe: its target and its drive).</summary>
        [JsonPropertyName("canRequest4k")] public bool CanRequest4k { get; init; }

        /// <summary>Why the viewer can't ask for the 4K edition now although their role may (as <see cref="Blocked"/>).</summary>
        [JsonPropertyName("blocked4k")] public RequestBlock? Blocked4k { get; init; }

        /// <summary>The viewer's 4K request state of the whole season.</summary>
        [JsonPropertyName("seasonRequest4k")] public string? SeasonRequest4k { get; init; }

        /// <summary>Episodes in number order: request state for all, metadata for the ones without a file.</summary>
        [JsonPropertyName("episodes")] public IReadOnlyList<SeasonRowEpisode> Episodes { get; init; } = Array.Empty<SeasonRowEpisode>();

        /// <summary>
        /// The episode numbers the provider's (TMDB's) season lists, in order, without those hidden from the viewer: what the
        /// page's metadata is numbered by. Null when the provider's season couldn't be read.
        /// </summary>
        [JsonPropertyName("providerEpisodes")] public IReadOnlyList<int>? ProviderEpisodes { get; init; }

        /// <summary>
        /// Whether the episodes TMDB describes are the episodes a request for their numbers reaches (see
        /// <see cref="EpisodeNumbering"/>); null when nothing could be worked out (a client then holds single episodes).
        /// </summary>
        [JsonPropertyName("numbering")] public EpisodeNumbering? Numbering { get; init; }
    }

    /// <summary>
    /// The season's episode identity between the provider whose facts the page shows (TMDB) and the destination a request
    /// names episodes by number at (the request target's Sonarr). Only the verdict leaves the server: no titles or dates.
    /// </summary>
    public sealed record EpisodeNumbering
    {
        /// <summary>
        /// <c>agree</c>: every episode both list is the same episode (its title matches, its air day breaking ties);
        /// <c>conflict</c>: some number TMDB describes can't be shown to be the destination's episode of that number (another
        /// title, no usable title, or an ambiguous title the air day doesn't settle); <c>provider</c>: the request names
        /// TMDB's numbering (the destination doesn't hold the series yet, or Seerr takes the request);
        /// <c>destination</c>: TMDB's season couldn't be read, so nothing of it is shown; <c>unknown</c>: the destination's
        /// episode list couldn't be read.
        /// </summary>
        [JsonPropertyName("state")] public string State { get; init; } = "unknown";

        /// <summary>Episodes only the destination lists (TMDB has nothing to show for them), in order.</summary>
        [JsonPropertyName("destinationOnly")] public IReadOnlyList<int> DestinationOnly { get; init; } = Array.Empty<int>();
    }

    /// <summary>One destination episode of a season as the identity check reads it.</summary>
    /// <param name="Episode">Episode number.</param>
    /// <param name="Title">Title as the destination lists it.</param>
    /// <param name="AirDateUtc">Air time (UTC).</param>
    public sealed record DestinationEpisode(int Episode, string? Title, DateTime? AirDateUtc);

    /// <summary>
    /// The destination's view of one season: <paramref name="Read"/> false when its lists couldn't be read; otherwise
    /// <paramref name="Holds"/> says whether it has the series, and <paramref name="Episodes"/> lists that season.
    /// </summary>
    /// <param name="Read">The destination answered.</param>
    /// <param name="Holds">It has the series.</param>
    /// <param name="Episodes">The season's episodes.</param>
    public sealed record DestinationSeason(bool Read, bool Holds, IReadOnlyList<DestinationEpisode> Episodes)
    {
        /// <summary>Couldn't be read.</summary>
        public static DestinationSeason Unread => new(false, false, Array.Empty<DestinationEpisode>());

        /// <summary>Read; the series isn't there.</summary>
        public static DestinationSeason NotHeld => new(true, false, Array.Empty<DestinationEpisode>());
    }

    /// <summary>
    /// Season rows for the "Get it" controls and the episode rows JE draws for missing episodes Jellyfin
    /// has no row for: one read per season page. Metadata comes from TMDB through the shared
    /// <see cref="TmdbResponseCache"/> (server key, cached); request states come from the ledger.
    /// Nothing about instances, paths or other people is returned, and episodes Jellyfin hides from the
    /// viewer (rating, tags, hidden seasons) are left out.
    /// </summary>
    public sealed class SeasonRowsService
    {
        /// <summary>Longest overview sent (characters).</summary>
        public const int MaxOverview = 600;
        private static readonly Regex StillPath = new("^/[A-Za-z0-9_.-]{1,80}$", RegexOptions.CultureInvariant);
        private static readonly Regex Language = new("^[a-z]{2}(-[A-Z]{2})?$", RegexOptions.CultureInvariant);
        private readonly IArrJellyfinView _view;
        private readonly SpoilerPresentation? _presentation;
        private readonly RequestLedger _ledger;
        private readonly IRequestPolicy _policy;
        private readonly TitleAliases? _aliases;
        private readonly Func<int, int, string?, CancellationToken, Task<string?>> _tmdbSeason;
        private readonly Func<string, IReadOnlyList<TitleKey>, int, CancellationToken, Task<DestinationSeason>>? _destination;
        private readonly Func<DateTimeOffset> _now;
        private readonly ResponseGate _gate;

        /// <summary>Creates the service over the shared TMDB cache and the arrs' snapshots.</summary>
        public SeasonRowsService(IArrJellyfinView view, RequestLedger ledger, IRequestPolicy policy, TitleAliases aliases, TmdbResponseCache tmdb, SpoilerPresentation? presentation = null, Arr.ArrStateStore? arrs = null)
            : this(view, ledger, policy, aliases, (id, season, language, ct) => TmdbSeasonAsync(tmdb, id, season, language, ct), destination: arrs == null ? null : (instance, titles, season, ct) => DestinationSeasonAsync(arrs, instance, titles, season, ct))
        {
            _presentation = presentation;
        }

        /// <summary>Creates the service with an explicit TMDB season reader and destination reader (tests).</summary>
        internal SeasonRowsService(IArrJellyfinView view, RequestLedger ledger, IRequestPolicy policy, TitleAliases? aliases, Func<int, int, string?, CancellationToken, Task<string?>> tmdbSeason, Func<DateTimeOffset>? now = null, SpoilerPresentation? presentation = null,
            Func<string, IReadOnlyList<TitleKey>, int, CancellationToken, Task<DestinationSeason>>? destination = null)
        {
            _destination = destination;
            _presentation = presentation;
            _view = view;
            _ledger = ledger;
            _policy = policy;
            _aliases = aliases;
            _tmdbSeason = tmdbSeason;
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _gate = new ResponseGate(view, () => policy.Configuration, () => policy.EvidenceRevision);
        }

        /// <summary>
        /// The rows of one season item the viewer can see, or null (not a season, not visible to the
        /// viewer, or no usable provider id). Published through the response gate (D53, edition round 19): the metadata and
        /// policy reads await; after the last of them the season, its episodes (what the library hides from the viewer
        /// included) and the request states are read again for the viewer as Jellyfin has them now, so an episode hidden
        /// meanwhile never carries its title or synopsis. A viewer whose policy changed meanwhile gets the rows prepared again.
        /// </summary>
        public async Task<SeasonRows?> ForSeasonAsync(StatusViewer viewer, Guid seasonId, string? language, CancellationToken ct)
        {
            for (var attempt = 0; attempt < ResponseGate.Attempts; attempt++)
            {
                var stamp = _gate.Take(viewer);
                if (_view.Resolve(seasonId, viewer) is not { Kind: "season", Key: { } key, SeriesId: Guid seriesId, Season: int season } item) return null;
                var tmdbId = item.TmdbId ?? _aliases?.Of(key.Title).Append(key.Title).FirstOrDefault(k => k.Provider == "tmdb" && !k.IsMovie)?.NumericId;
                var prepared = await PrepareAsync(viewer.UserId, key, season, tmdbId, language, ct).ConfigureAwait(false);
                // Publication: no await from here on.
                if (_gate.Current(stamp, rereadsLibrary: true) is { } now)
                {
                    var before = _gate.Take(now);
                    if (_view.Resolve(seasonId, now) is not { Kind: "season", SeriesId: Guid still } || still != seriesId) return null;
                    var jf = _view.Episodes(seriesId, season, now, includeVirtual: true).Where(e => e.Season == season).ToList();
                    var rows = Project(now, key, seriesId.ToString("N", System.Globalization.CultureInfo.InvariantCulture), season, tmdbId, jf, prepared);
                    // The viewer didn't change while it was projected: published; else read again for them as they are then.
                    if (ResponseGate.SameViewer(before, _gate.Take(now))) return rows;
                    viewer = now;
                    continue;
                }
                if (_view.Viewer(viewer.UserId) is not { } changed) return null;
                viewer = changed;
            }
            return null;
        }

        /// <summary>
        /// The rows of a season of a title that isn't in the library (the native details page of an
        /// absent title, whose ids are page ids): every episode comes from public metadata, none has a
        /// file. The caller has already applied the page's viewer rules.
        /// </summary>
        /// <param name="viewer">Viewer.</param>
        /// <param name="page">The absent season page.</param>
        /// <param name="language">Metadata language.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The rows.</returns>
        public Task<SeasonRows?> ForAbsentSeasonAsync(StatusViewer viewer, AbsentTitle page, string? language, CancellationToken ct)
            => ForAbsentSeasonAsync(viewer, page, language, ct, Admission(viewer));

        /// <summary>Captures admission before the caller resolves an absent page, including its awaited policy reads.</summary>
        internal ResponseStamp Admission(StatusViewer viewer) => _gate.Take(viewer);

        internal Task<SeasonRows?> ForAbsentSeasonAsync(StatusViewer viewer, AbsentTitle page, string? language, CancellationToken ct, ResponseStamp admission)
        {
            if (page.Kind != "season" || page.Season is not int season || page.SeriesPageId is not Guid seriesPageId || _gate.Current(admission) == null)
                return Task.FromResult<SeasonRows?>(null);
            var hidden = page.HiddenEpisodes.Select(n => new JfEpisode { Season = season, Episode = n, Hidden = true }).ToList();
            return ComposeAbsentAsync(viewer, page, seriesPageId, season, hidden, language, ct, admission);
        }

        private async Task<SeasonRows?> ComposeAbsentAsync(StatusViewer viewer, AbsentTitle page, Guid seriesPageId, int season, List<JfEpisode> hidden, string? language, CancellationToken ct, ResponseStamp stamp)
        {
            var prepared = await PrepareAsync(viewer.UserId, page.ScopeKey, season, page.TmdbId, language, ct).ConfigureAwait(false);
            // The page (what the library hides from the viewer, their Spoiler Guard) was read for the viewer and the library as
            // they were before the metadata read: none when either changed meanwhile (the page asks again).
            if (_gate.Current(stamp) is not { } now) return null;
            // The resolver already knows TMDB even when an absent series' TVDB alias is not in any arr index yet.
            var visibilityKey = TitleKey.Parse("tv:tmdb:" + page.TmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture)) ?? page.Title;
            if (!_policy.Evaluate(now.UserId, Probe(visibilityKey, season, "standard")).Visible) return null;
            var rows = Project(now, page.ScopeKey, seriesPageId.ToString("N", System.Globalization.CultureInfo.InvariantCulture), season, page.TmdbId, hidden, prepared);
            if (page.Spoilers is not { } spoilers) return _gate.Current(stamp) != null ? rows : null;
            // Spoiler Guard on the title: the rows carry no plot (as the page's own episode list).
            var guarded = rows with
            {
                Episodes = rows.Episodes.Select(e => e with
                {
                    Title = spoilers.Title ? null : e.Title,
                    Overview = spoilers.Overview ? null : e.Overview,
                    AirDate = spoilers.AirDate ? null : e.AirDate,
                    Still = null,
                }).ToList(),
            };
            return _gate.Current(stamp) != null ? guarded : null;
        }

        /// <summary>What a season's rows are composed from, read ahead of publication.</summary>
        /// <param name="Meta">TMDB's episodes in the viewer's language (what the rows show).</param>
        /// <param name="Numbering">The identity verdict between TMDB's episodes and the request target's (null: none worked out).</param>
        private sealed record Prepared(Dictionary<int, SeasonRowEpisode> Meta, Func<ISet<int>, EpisodeNumbering?> Numbering);

        /// <summary>
        /// The metadata of a season's episodes (TMDB), the policy's disk facts of both editions and the episode identity between
        /// TMDB and the standard request target's Sonarr, read ahead of publication.
        /// </summary>
        private async Task<Prepared> PrepareAsync(Guid viewer, TitleKey key, int season, int? tmdbId, string? language, CancellationToken ct)
        {
            var meta = new Dictionary<int, SeasonRowEpisode>();
            var shown = language != null && Language.IsMatch(language) ? language : null;
            if (tmdbId is int id && id > 0)
            {
                using var metadataViewer = NativeDetails.ViewerMetadataAdmission.ForViewer(viewer);
                var json = await _tmdbSeason(id, season, shown, ct).ConfigureAwait(false);
                foreach (var episode in ParseSeason(json)) meta[episode.Episode] = episode;
            }
            var canonical = _aliases?.Canonical(key.Title) ?? key.Title;
            foreach (var variant in new[] { "standard", "4k" }) await _policy.PrepareDiskAsync(Probe(canonical, season, variant), ct).ConfigureAwait(false);
            // Seerr numbers what it is sent the way TMDB does; Jellyfin Enhanced sends it to the standard target's Sonarr.
            var seerr = _policy.Configuration.ArrRequestBackend == "seerr";
            DestinationSeason? destination = null;
            if (!seerr && _destination != null)
            {
                var (instance, _) = _policy.JeTarget(viewer, Probe(canonical, season, "standard"));
                var titles = (_aliases?.Of(key.Title) ?? Array.Empty<TitleKey>()).Append(key.Title).Append(canonical).Distinct().ToList();
                if (string.IsNullOrEmpty(instance)) destination = DestinationSeason.Unread;
                else
                {
                    try { destination = await _destination(instance, titles, season, ct).ConfigureAwait(false); }
                    catch (Exception e) when (e is not OperationCanceledException) { destination = DestinationSeason.Unread; }
                }
            }
            // Identity is matched on TMDB's English titles (the language Sonarr lists them in): read only when there is a
            // Sonarr season to match them to and the rows are shown in another language.
            var identity = meta;
            if (destination is { Read: true, Holds: true } && meta.Count > 0 && shown != null && !shown.StartsWith("en", StringComparison.Ordinal) && tmdbId is int english)
            {
                using var metadataViewer = NativeDetails.ViewerMetadataAdmission.ForViewer(viewer);
                identity = new Dictionary<int, SeasonRowEpisode>();
                foreach (var episode in ParseSeason(await _tmdbSeason(english, season, null, ct).ConfigureAwait(false))) identity[episode.Episode] = episode;
            }
            var provider = identity;
            return new Prepared(meta, hidden => seerr ? new EpisodeNumbering { State = "provider" } : destination == null ? null : Reconcile(destination, provider, hidden));
        }

        /// <summary>The request target's view of a season: its Sonarr's episode list for the series (aliases tried in turn).</summary>
        private static async Task<DestinationSeason> DestinationSeasonAsync(Arr.ArrStateStore arrs, string instanceId, IReadOnlyList<TitleKey> titles, int season, CancellationToken ct)
        {
            var instance = arrs.Registry.Get(instanceId);
            if (instance == null || !instance.Usable || instance.Kind != Arr.ArrKind.Sonarr) return DestinationSeason.Unread;
            var library = await arrs.GetLibraryAsync(instance, ct).ConfigureAwait(false);
            if (library.Value is not { } snapshot) return DestinationSeason.Unread;
            var series = titles.Select(t => t.Provider switch
            {
                "tvdb" when t.NumericId is int tvdb => snapshot.SeriesByTvdb(tvdb),
                "tmdb" when t.NumericId is int tmdb => snapshot.SeriesByTmdb(tmdb),
                "imdb" => snapshot.SeriesByImdb(t.Id),
                _ => null,
            }).FirstOrDefault(s => s != null);
            if (series == null) return DestinationSeason.NotHeld;
            var episodes = await arrs.GetEpisodesAsync(instance, series.Id, ct).ConfigureAwait(false);
            if (episodes.Value is not { } list) return DestinationSeason.Unread;
            return new DestinationSeason(true, true, list.Episodes.Where(e => e.SeasonNumber == season).Select(e => new DestinationEpisode(e.EpisodeNumber, e.Title, e.AirDateUtc)).ToList());
        }

        private static readonly Regex Generic = new(@"^(episode|ep|chapter|part|tba|tbd|untitled|pilot episode)?\s*\d*$", RegexOptions.CultureInvariant);

        /// <summary>A title's words for matching (lower case, no accents or punctuation, "&amp;" read as "and"); empty when generic.</summary>
        internal static string[] TitleWords(string? title)
        {
            if (string.IsNullOrWhiteSpace(title)) return Array.Empty<string>();
            var decomposed = title.Replace("&", " and ", StringComparison.Ordinal).Normalize(System.Text.NormalizationForm.FormD);
            var text = new System.Text.StringBuilder(decomposed.Length);
            foreach (var ch in decomposed)
            {
                if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch) == System.Globalization.UnicodeCategory.NonSpacingMark) continue;
                text.Append(char.IsLetterOrDigit(ch) ? char.ToLowerInvariant(ch) : ' ');
            }
            var words = text.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return Generic.IsMatch(string.Join(' ', words)) ? Array.Empty<string>() : words;
        }

        /// <summary>Two titles name the same episode: the same words, or mostly the same (a "(1)" or an article apart).</summary>
        internal static bool SameTitle(string[] a, string[] b)
        {
            if (a.Length == 0 || b.Length == 0) return false;
            if (a.SequenceEqual(b)) return true;
            var x = a.ToHashSet(StringComparer.Ordinal);
            var y = b.ToHashSet(StringComparer.Ordinal);
            var common = x.Intersect(y).Count();
            return common > 0 && (double)common / x.Union(y).Count() >= 0.6;
        }

        /// <summary>
        /// The identity verdict of a season (see <see cref="EpisodeNumbering"/>). An episode both list is the same episode only
        /// when its titles match; a title that matches more than one episode of either list is settled by the air day (a day
        /// apart counts as the same), and only when that leaves one. Anything else is not established, so the season is a
        /// conflict: a number TMDB describes is never taken for the destination's episode on proximity alone.
        /// </summary>
        internal static EpisodeNumbering Reconcile(DestinationSeason destination, IReadOnlyDictionary<int, SeasonRowEpisode> provider, ISet<int> hidden)
        {
            if (!destination.Read) return new EpisodeNumbering { State = "unknown" };
            if (!destination.Holds) return new EpisodeNumbering { State = "provider" };
            var dest = destination.Episodes.Where(e => !hidden.Contains(e.Episode)).GroupBy(e => e.Episode).Select(g => g.First()).OrderBy(e => e.Episode).ToList();
            var tmdb = provider.Where(p => !hidden.Contains(p.Key)).ToDictionary(p => p.Key, p => p.Value);
            var only = dest.Where(e => !tmdb.ContainsKey(e.Episode)).Select(e => e.Episode).ToList();
            if (tmdb.Count == 0) return new EpisodeNumbering { State = "destination", DestinationOnly = only };
            var destWords = dest.ToDictionary(e => e.Episode, e => TitleWords(e.Title));
            var tmdbWords = tmdb.ToDictionary(p => p.Key, p => TitleWords(p.Value.Title));
            var established = true;
            foreach (var e in dest)
            {
                if (!tmdb.TryGetValue(e.Episode, out var shown)) continue;
                var words = tmdbWords[e.Episode];
                if (!SameTitle(destWords[e.Episode], words)) { established = false; break; }
                // The same title elsewhere in either list: only the air day can tell which is which.
                var rivals = dest.Count(d => d.Episode != e.Episode && SameTitle(destWords[d.Episode], words))
                    + tmdb.Count(t => t.Key != e.Episode && SameTitle(tmdbWords[t.Key], words));
                if (rivals == 0) continue;
                var day = e.AirDateUtc?.Date;
                var tmdbDay = DateTime.TryParseExact(shown.AirDate, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var d0) ? d0 : (DateTime?)null;
                bool Near(DateTime? a, DateTime? b) => a is { } p && b is { } q && Math.Abs((p - q).TotalDays) <= 1;
                var unique = Near(day, tmdbDay)
                    && !dest.Any(d => d.Episode != e.Episode && SameTitle(destWords[d.Episode], words) && Near(d.AirDateUtc?.Date, tmdbDay))
                    && !tmdb.Any(t => t.Key != e.Episode && SameTitle(tmdbWords[t.Key], words) && Near(day, DateTime.TryParseExact(t.Value.AirDate, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var d1) ? d1 : null));
                if (!unique) { established = false; break; }
            }
            return new EpisodeNumbering { State = established ? "agree" : "conflict", DestinationOnly = only };
        }

        /// <summary>The policy probe of a season's episodes in one edition.</summary>
        private static MutationInput Probe(TitleKey canonical, int season, string variant)
            => new() { Key = canonical.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(season, 1) }, Variant = variant };

        /// <summary>
        /// The rows from Jellyfin's episodes as the viewer sees them now, the metadata read ahead, the policy and the ledger (no
        /// I/O): each edition's request states and policy probe on its own target (D53, edition round 19: a control reads its
        /// own binding's edition, never the other one's).
        /// </summary>
        private SeasonRows Project(StatusViewer viewer, TitleKey key, string seriesId, int season, int? tmdbId, List<JfEpisode> jf, Prepared prepared)
        {
            var meta = prepared.Meta;
            var hidden = new HashSet<int>(jf.Where(e => e.Hidden).SelectMany(Numbers));
            var withFile = new HashSet<int>(jf.Where(EditionAvailability.Plays).SelectMany(Numbers));
            var canonical = _aliases?.Canonical(key.Title) ?? key.Title;
            var facts = _policy.Evaluate(viewer.UserId, Probe(canonical, season, "standard"));
            var facts4k = _policy.Evaluate(viewer.UserId, Probe(canonical, season, "4k"));
            IReadOnlyList<RequestWant> wants = _ledger.Database.Available ? _ledger.ForTitle(canonical.ToString()) : Array.Empty<RequestWant>();
            var cooldown = _policy.Configuration.ArrRequestDeclineCooldownDays;
            var (perEpisode, seasonState) = RequestStates(wants, viewer.UserId, season, _now(), cooldown, RequestLedger.TargetKey(facts));
            var (perEpisode4k, seasonState4k) = RequestStates(wants, viewer.UserId, season, _now(), cooldown, RequestLedger.TargetKey(facts4k), "4k");

            var canRequest = facts.Refusal == null && facts.CanCreate && facts.Backend is "je" or "seerr";
            var canRequest4k = facts4k.Refusal == null && facts4k.CanCreate && facts4k.Can4k && facts4k.Backend is "je" or "seerr";
            var numbers = new SortedSet<int>(meta.Keys);
            numbers.UnionWith(perEpisode.Keys);
            numbers.UnionWith(perEpisode4k.Keys);
            numbers.UnionWith(jf.Where(e => !e.Hidden).SelectMany(Numbers));
            numbers.ExceptWith(hidden);
            var presentation = _presentation?.Load(viewer.UserId);
            var title = tmdbId.HasValue ? "tv:tmdb:" + tmdbId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : key.Title.ToString();
            var strip = presentation?.MissingRow(title) ?? (Title: false, Overview: false, AirDate: false);
            var guarded = presentation?.Guarded(title) == true;
            var episodes = new List<SeasonRowEpisode>();
            foreach (var n in numbers)
            {
                var info = meta.GetValueOrDefault(n);
                var known = !withFile.Contains(n) && info != null;
                episodes.Add(new SeasonRowEpisode
                {
                    Episode = n,
                    Title = known && !strip.Title ? info!.Title : null,
                    Overview = known && !strip.Overview ? info!.Overview : null,
                    Runtime = known ? info!.Runtime : null,
                    AirDate = known && !strip.AirDate ? info!.AirDate : null,
                    Still = known && !guarded ? info!.Still : null,
                    Request = perEpisode.GetValueOrDefault(n),
                    Request4k = perEpisode4k.GetValueOrDefault(n),
                });
            }

            return new SeasonRows
            {
                Key = key.ToString(),
                Series = canonical.ToString(),
                Season = season,
                SeriesId = seriesId,
                DisplayMissing = viewer.DisplayMissingEpisodes,
                CanRequest = canRequest,
                Blocked = canRequest ? null : RequestBlock.Of(facts),
                SeasonRequest = seasonState,
                CanRequest4k = canRequest4k,
                Blocked4k = canRequest4k ? null : RequestBlock.Of(facts4k),
                SeasonRequest4k = seasonState4k,
                Episodes = episodes,
                ProviderEpisodes = meta.Count == 0 ? null : meta.Keys.Where(n => !hidden.Contains(n)).OrderBy(n => n).ToList(),
                Numbering = prepared.Numbering(hidden),
            };
        }

        /// <summary>
        /// The viewer's request state per episode of a season and of the season as a whole, from the wants of one edition
        /// (<paramref name="variant"/>: a control reads its own binding's edition, never the other one's): the viewer's own
        /// asks win over other people's (shown only as "household"), and asks on <paramref name="currentTarget"/> (where an
        /// ask of that edition goes now) over asks left on another target, such as an ask sent to Seerr before requests moved
        /// to Jellyfin Enhanced, whose request now waits for an OK here.
        /// </summary>
        internal static (Dictionary<int, string> Episodes, string? Season) RequestStates(IEnumerable<RequestWant> wants, Guid viewer, int season, DateTimeOffset now, int declineCooldownDays, string? currentTarget = null, string variant = "standard")
        {
            var episodes = new Dictionary<int, string>();
            var elsewhere = new Dictionary<int, string>();
            string? whole = null;
            string? wholeElsewhere = null;
            foreach (var want in wants)
            {
                if (want.Input.Variant != variant) continue;
                var state = StateOf(want, viewer, now, declineCooldownDays);
                if (state == null) continue;
                var here = currentTarget == null || want.TargetKey == currentTarget;
                var states = here ? episodes : elsewhere;
                var input = want.Input;
                if (input.Scope == "episodes")
                {
                    foreach (var e in input.Episodes.Where(e => e.Season == season)) states[e.Episode] = Stronger(states.GetValueOrDefault(e.Episode), state);
                }
                else if (input.Scope is "seasons" or "future" or "next_season" && input.Seasons.Contains(season))
                {
                    if (here) whole = Stronger(whole, state);
                    else wholeElsewhere = Stronger(wholeElsewhere, state);
                }
            }
            // A whole-season ask on the current target covers every episode, so asks left elsewhere don't show then.
            if (whole == null)
                foreach (var (episode, state) in elsewhere) episodes.TryAdd(episode, state);
            return (episodes, whole ?? wholeElsewhere);
        }

        /// <summary>
        /// What one want means to the viewer: waiting (for an OK, here or in Seerr), asked (recorded or sent), declined
        /// (their own, only while the decline still blocks asking again, as the ledger does), household
        /// (someone else's open ask), or null.
        /// </summary>
        internal static string? StateOf(RequestWant want, Guid viewer, DateTimeOffset now, int declineCooldownDays)
        {
            var state = want.Status switch
            {
                "pending" => "waiting",
                // Sent to Seerr, where it waits for an OK (Seerr mode): still waiting, not asked-and-on-its-way.
                "sent" when want.Reason == "awaiting_approval" => "waiting",
                "queued" or "sent" or "stale" => "asked",
                "declined" => "declined",
                _ => null,
            };
            if (state == "declined" && (want.UserId != viewer || want.UpdatedAt <= now.AddDays(-Math.Clamp(declineCooldownDays, 0, 365)))) return null;
            if (state != null && want.UserId != viewer) return "household";
            return state;
        }

        /// <summary>The state to show when two asks cover the same episode: the viewer's own first.</summary>
        internal static string Stronger(string? current, string next)
        {
            static int Rank(string? s) => s switch { "asked" => 4, "waiting" => 3, "declined" => 2, "household" => 1, _ => 0 };
            return Rank(next) > Rank(current) ? next : current!;
        }

        /// <summary>Parses TMDB's season details into episode metadata (invalid parts left out).</summary>
        internal static IEnumerable<SeasonRowEpisode> ParseSeason(string? json)
        {
            if (string.IsNullOrWhiteSpace(json)) yield break;
            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(json);
            }
            catch (JsonException)
            {
                yield break;
            }
            using (doc)
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("episodes", out var list) || list.ValueKind != JsonValueKind.Array) yield break;
                foreach (var e in list.EnumerateArray())
                {
                    if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("episode_number", out var number) || number.ValueKind != JsonValueKind.Number || !number.TryGetInt32(out var n) || n < 1 || n > 100000) continue;
                    var overview = Text(e, "overview");
                    if (overview?.Length > MaxOverview) overview = overview[..(MaxOverview - 1)].TrimEnd() + "…";
                    var air = Text(e, "air_date");
                    var still = Text(e, "still_path");
                    int? runtime = e.TryGetProperty("runtime", out var r) && r.ValueKind == JsonValueKind.Number && r.TryGetInt32(out var minutes) && minutes > 0 && minutes < 1000 ? minutes : null;
                    yield return new SeasonRowEpisode
                    {
                        Episode = n,
                        Title = Text(e, "name") is { } name && name.Length > 200 ? name[..200] : Text(e, "name"),
                        Overview = overview,
                        Runtime = runtime,
                        AirDate = air != null && DateTime.TryParseExact(air, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out _) ? air : null,
                        Still = still != null && StillPath.IsMatch(still) ? still : null,
                    };
                }
            }
        }

        private static string? Text(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString()!.Trim() : null;

        private static IEnumerable<int> Numbers(JfEpisode e)
        {
            var end = Math.Min(Math.Max(e.EpisodeEnd ?? e.Episode, e.Episode), e.Episode + 50);
            for (var n = e.Episode; n <= end; n++) yield return n;
        }

        /// <summary>TMDB season details through the shared cache (null when TMDB isn't set up or fails).</summary>
        private static async Task<string?> TmdbSeasonAsync(TmdbResponseCache tmdb, int seriesId, int season, string? language, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            if (string.IsNullOrEmpty(key)) return null;
            try
            {
                var response = await tmdb.GetAsync($"tv/{seriesId}/season/{season}", language == null ? string.Empty : "?language=" + language, key, ct).ConfigureAwait(false);
                return response.IsSuccess ? response.Content : null;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return null;
            }
            catch (System.Net.Http.HttpRequestException)
            {
                return null;
            }
        }
    }
}

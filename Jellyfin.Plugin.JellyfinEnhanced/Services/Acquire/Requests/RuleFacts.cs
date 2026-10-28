using System;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>A streaming service a title is on (TMDB watch provider).</summary>
    /// <param name="Id">TMDB provider id.</param>
    /// <param name="Name">Provider name.</param>
    public sealed record RuleProvider(int Id, string Name);

    /// <summary>
    /// The public metadata facts household rules read for one title, from TMDB through the shared bounded cache, never
    /// from the browser: certifications per country, genres, original language and streaming services per country. A
    /// null part was not known (the lookup failed); an empty one is known to be empty. <see cref="Version"/> fingerprints
    /// the facts, so a verdict says which facts it was worked out from.
    /// </summary>
    /// <param name="TmdbId">TMDB id (null: the title has none known).</param>
    /// <param name="Certifications">Certification per country (ISO 3166-1), or null.</param>
    /// <param name="Genres">TMDB genre ids, or null.</param>
    /// <param name="OriginalLanguage">ISO 639-1 original language, or null.</param>
    /// <param name="Providers">Flat-rate/free/ad-supported services per country, or null.</param>
    /// <param name="FetchedAt">When they were read (a failed read never moves it).</param>
    public sealed record RuleFactSet(int? TmdbId, IReadOnlyDictionary<string, string>? Certifications, IReadOnlyList<int>? Genres, string? OriginalLanguage,
        IReadOnlyDictionary<string, IReadOnlyList<RuleProvider>>? Providers, DateTimeOffset FetchedAt)
    {
        /// <summary>True when nothing at all could be read.</summary>
        public bool Failed => Certifications == null && Genres == null && OriginalLanguage == null && Providers == null;

        /// <summary>The certification in a country, or null (unrated there, or not known).</summary>
        /// <param name="country">ISO 3166-1 code.</param>
        public string? Certification(string country) => Certifications != null && Certifications.TryGetValue(country.ToUpperInvariant(), out var cert) ? cert : null;

        /// <summary>The services a title is on in a country (empty: on none), or null when not known.</summary>
        /// <param name="country">ISO 3166-1 code.</param>
        public IReadOnlyList<RuleProvider>? ProvidersIn(string country)
            => Providers == null ? null : Providers.TryGetValue(country.ToUpperInvariant(), out var list) ? list : Array.Empty<RuleProvider>();

        /// <summary>Fingerprint of the facts (not the time they were read).</summary>
        public string Version => MutationInput.Hash(JsonSerializer.Serialize(new
        {
            TmdbId,
            c = Certifications?.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => p.Key + "=" + p.Value),
            g = Genres?.OrderBy(g => g),
            OriginalLanguage,
            p = Providers?.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => p.Key + "=" + string.Join(",", p.Value.Select(x => x.Id).OrderBy(i => i))),
        }))[..16];
    }

    /// <summary>Reads the facts household rules need, bounded; <see cref="Peek"/> answers from memory only.</summary>
    public interface IHouseholdRuleFacts
    {
        /// <summary>Makes sure fresh facts for the title are in memory (bounded wait; a failure leaves them unknown).</summary>
        /// <param name="title">The title.</param>
        /// <param name="ct">Cancellation.</param>
        Task PrepareAsync(TitleKey title, CancellationToken ct);

        /// <summary>
        /// The facts in memory for the title that household rules may decide on, or null: facts older than their freshness
        /// window count as not known (a review, never the old answer) until a read succeeds again.
        /// </summary>
        /// <param name="title">The title.</param>
        RuleFactSet? Peek(TitleKey title);

        /// <summary>Scores a certification in a country (Jellyfin's rating scores), or null when it can't be scored.</summary>
        /// <param name="certification">The certification.</param>
        /// <param name="country">ISO 3166-1 code.</param>
        int? Score(string certification, string country);
    }

    /// <summary>
    /// Household-rule facts from TMDB through <see cref="TmdbResponseCache"/> (one bundled read for a movie: details,
    /// release dates and watch providers; a series adds its content ratings), kept in a bounded memory cache: six hours
    /// when read, two minutes when the read failed. A failed read never replaces facts that were read, but it doesn't
    /// keep them fresh either: once their six hours are up they count as not known until a read succeeds (it is tried
    /// again two minutes after each failure). A title known only by its TVDB or IMDb id is found on TMDB first.
    /// </summary>
    public sealed class HouseholdRuleFacts : IHouseholdRuleFacts
    {
        /// <summary>How long read facts count as fresh.</summary>
        internal static readonly TimeSpan FreshFor = TimeSpan.FromHours(6);

        /// <summary>How long a failed read is kept before it is tried again.</summary>
        internal static readonly TimeSpan FailedFor = TimeSpan.FromMinutes(2);

        /// <summary>Most titles kept.</summary>
        internal const int MaxEntries = 4000;

        private static readonly TimeSpan Wait = TimeSpan.FromSeconds(8);
        // The facts last read (or the failed read when nothing was ever read) and when a read was last tried.
        private readonly RegisteredCache<string, SeerrFacts.Derived<(RuleFactSet Facts, DateTimeOffset TriedAt)>> _cache = new(StringComparer.Ordinal);
        private readonly Func<TitleKey, CancellationToken, Task<int?>> _tmdbId;
        private readonly Func<string, CancellationToken, Task<string?>> _get;
        private readonly Func<string, string, int?> _score;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>Creates the reader over the shared TMDB cache (DI).</summary>
        public HouseholdRuleFacts(TmdbResponseCache tmdb, TitleAliases aliases, ILocalizationManager localization)
            : this(
                async (title, ct) => title.Provider == "tmdb" ? title.NumericId
                    : aliases.Of(title).FirstOrDefault(k => k.Provider == "tmdb")?.NumericId ?? await RequestHubProjection.TmdbIdOfAsync(tmdb, title, ct).ConfigureAwait(false),
                async (path, ct) =>
                {
                    var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
                    if (string.IsNullOrEmpty(key)) return null;
                    var answer = await tmdb.GetAsync(path, string.Empty, key, ct, bundle: true).ConfigureAwait(false);
                    return answer.IsSuccess ? answer.Content : null;
                },
                (cert, country) =>
                {
                    try { return localization.GetRatingScore(cert, country)?.Score; }
                    catch (Exception) { return null; }
                },
                () => DateTimeOffset.UtcNow)
        {
        }

        /// <summary>Creates the reader over explicit reads (tests): the TMDB id of a title, a TMDB path's body (null: failed), scores, time.</summary>
        internal HouseholdRuleFacts(Func<TitleKey, CancellationToken, Task<int?>> tmdbId, Func<string, CancellationToken, Task<string?>> get, Func<string, string, int?> score, Func<DateTimeOffset> now)
        {
            _tmdbId = tmdbId;
            _get = get;
            _score = score;
            _now = now;
        }

        /// <inheritdoc />
        public int? Score(string certification, string country) => string.IsNullOrWhiteSpace(certification) ? null : _score(certification.Trim(), country.ToUpperInvariant());

        /// <inheritdoc />
        public RuleFactSet? Peek(TitleKey title)
        {
            if (!_cache.TryGetValue(CacheKey(title), out var entry) || !entry.TryRead(out var held)) return null;
            return held.Facts.Failed || _now() - held.Facts.FetchedAt < FreshFor ? held.Facts : null;
        }

        private static string CacheKey(TitleKey title) => title.Title.ToString();

        /// <inheritdoc />
        public async Task PrepareAsync(TitleKey title, CancellationToken ct)
        {
            using var operation = SeerrFacts.BeginPublication();
            var ticket = _cache.Begin();
            var key = CacheKey(title);
            var now = _now();
            var held = default((RuleFactSet Facts, DateTimeOffset TriedAt));
            if (_cache.TryGetValue(key, out var entry) && entry.TryRead(out held) && (held.Facts.Failed ? now - held.TriedAt < FailedFor : now - held.Facts.FetchedAt < FreshFor || now - held.TriedAt < FailedFor)) return;
            using var bounded = CancellationTokenSource.CreateLinkedTokenSource(ct);
            bounded.CancelAfter(Wait);
            RuleFactSet facts;
            try
            {
                facts = await ReadAsync(title.Title, bounded.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is OperationCanceledException or System.Net.Http.HttpRequestException or JsonException or InvalidOperationException)
            {
                if (ct.IsCancellationRequested) return;
                facts = new RuleFactSet(null, null, null, null, null, _now());
            }

            // A failed read never replaces facts that were read before, and never makes them fresh again: past their window
            // Peek says they aren't known (rules ask for a look), and the read is tried again after FailedFor.
            if (facts.Failed && held.Facts is { Failed: false }) facts = held.Facts;
            if (_cache.Count >= MaxEntries)
            {
                foreach (var old in _cache.Snapshot().OrderBy(p => p.Value.Read(default).TriedAt).Take(MaxEntries / 4).ToList()) _cache.TryRemove(old.Key, out _);
            }

            // Tried when the read began (now, taken before it).
            _cache.Set(key, ticket, SeerrFacts.Remember((facts, now)));
        }

        private async Task<RuleFactSet> ReadAsync(TitleKey title, CancellationToken ct)
        {
            // Also called by automatic request evaluation outside an authenticated MVC response.
            if (MetadataAdmission.Current == null && NativeDetails.ViewerMetadataAdmission.EffectiveViewer == null)
                return await AutonomousMetadataAdmission.RunAsync(AutonomousMetadataOwner.Automation,
                    () => ReadAsync(title, ct)).ConfigureAwait(false);

            var now = _now();
            if (await _tmdbId(title, ct).ConfigureAwait(false) is not int id || id <= 0) return new RuleFactSet(null, null, null, null, null, now);
            var media = title.IsMovie ? "movie" : "tv";
            var path = media + "/" + id.ToString(CultureInfo.InvariantCulture);
            var details = await _get(path, ct).ConfigureAwait(false);
            var ratings = await _get(path + (title.IsMovie ? "/release_dates" : "/content_ratings"), ct).ConfigureAwait(false);
            var providers = await _get(path + "/watch/providers", ct).ConfigureAwait(false);
            var (genres, language) = details == null ? (null, null) : Details(details);
            return new RuleFactSet(id, ratings == null ? null : Certifications(ratings, title.IsMovie), genres, language, providers == null ? null : Providers(providers), now);
        }

        /// <summary>Genre ids and original language from a TMDB details answer (null parts when unreadable).</summary>
        internal static (IReadOnlyList<int>? Genres, string? Language) Details(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                IReadOnlyList<int>? genres = null;
                if (root.TryGetProperty("genres", out var list) && list.ValueKind == JsonValueKind.Array)
                    genres = list.EnumerateArray().Select(g => g.TryGetProperty("id", out var gid) && gid.TryGetInt32(out var n) ? n : 0).Where(n => n > 0).Distinct().ToArray();
                var language = root.TryGetProperty("original_language", out var lang) && lang.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(lang.GetString())
                    ? lang.GetString()!.Trim().ToLowerInvariant() : null;
                return (genres, language);
            }
            catch (JsonException)
            {
                return (null, null);
            }
        }

        /// <summary>
        /// Certifications per country from TMDB's release dates (a movie: the theatrical certification first, else the
        /// first one given) or content ratings (a series). A country without one is left out (unrated there).
        /// </summary>
        internal static IReadOnlyDictionary<string, string>? Certifications(string json, bool movie)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return null;
                var map = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var country in results.EnumerateArray())
                {
                    if (!country.TryGetProperty("iso_3166_1", out var code) || code.ValueKind != JsonValueKind.String || code.GetString() is not { Length: 2 } iso) continue;
                    string? cert = null;
                    if (!movie)
                    {
                        cert = country.TryGetProperty("rating", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null;
                    }
                    else if (country.TryGetProperty("release_dates", out var dates) && dates.ValueKind == JsonValueKind.Array)
                    {
                        var given = dates.EnumerateArray()
                            .Select(d => (Type: d.TryGetProperty("type", out var t) && t.TryGetInt32(out var n) ? n : 0, Cert: d.TryGetProperty("certification", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null))
                            .Where(d => !string.IsNullOrWhiteSpace(d.Cert)).ToList();
                        cert = (given.FirstOrDefault(d => d.Type == 3).Cert) ?? given.FirstOrDefault().Cert;
                    }

                    if (!string.IsNullOrWhiteSpace(cert) && cert.Length <= 20) map[iso.ToUpperInvariant()] = cert.Trim();
                }

                return map;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        /// <summary>Flat-rate, free and ad-supported services per country from TMDB's watch providers.</summary>
        internal static IReadOnlyDictionary<string, IReadOnlyList<RuleProvider>>? Providers(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Object) return null;
                var map = new Dictionary<string, IReadOnlyList<RuleProvider>>(StringComparer.Ordinal);
                foreach (var country in results.EnumerateObject())
                {
                    if (country.Name.Length != 2 || country.Value.ValueKind != JsonValueKind.Object) continue;
                    var list = new List<RuleProvider>();
                    foreach (var kind in new[] { "flatrate", "free", "ads" })
                    {
                        if (!country.Value.TryGetProperty(kind, out var entries) || entries.ValueKind != JsonValueKind.Array) continue;
                        foreach (var p in entries.EnumerateArray())
                        {
                            if (p.TryGetProperty("provider_id", out var pid) && pid.TryGetInt32(out var n) && n > 0 && list.All(x => x.Id != n))
                                list.Add(new RuleProvider(n, p.TryGetProperty("provider_name", out var name) && name.ValueKind == JsonValueKind.String ? (name.GetString() ?? string.Empty).Trim() : string.Empty));
                        }
                    }

                    map[country.Name.ToUpperInvariant()] = list;
                }

                return map;
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }
}

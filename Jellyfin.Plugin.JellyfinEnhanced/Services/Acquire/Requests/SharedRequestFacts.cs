using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Who asked for a title, and whether that answer is complete.</summary>
    /// <param name="Complete">False while the source is still loading or only partly read: callers defer instead of deciding nobody asked.</param>
    /// <param name="Users">The Jellyfin users who asked (any state except declined or cancelled); when incomplete, those known so far.</param>
    /// <param name="Truncated">Incomplete because Seerr holds more requests than its read model keeps: waiting won't
    /// complete it, only the title's own request list from Seerr does.</param>
    public sealed record TitleRequesters(bool Complete, IReadOnlyList<Guid> Users, bool Truncated = false);

    /// <summary>What one person asked for (TMDB ids, for the watchlist), and whether the list is complete.</summary>
    /// <param name="Complete">False while the source is still loading or only partly read.</param>
    /// <param name="Titles">Movie flag and TMDB id of each title asked for.</param>
    public sealed record UserRequestedTitles(bool Complete, IReadOnlyList<(bool Movie, int TmdbId)> Titles);

    /// <summary>
    /// The request facts the watchlist features read once "Ask for it" (phase 3) is on: the request
    /// ledger in Jellyfin Enhanced mode, Seerr's background read model in Seerr mode, keyed by canonical
    /// title, with an explicit completeness flag (never an empty answer standing in for "couldn't tell").
    /// Reads memory and the local database only; no network calls.
    /// </summary>
    public sealed class SharedRequestFacts
    {
        private readonly RequestLedger _ledger;
        private readonly SeerrFacts _seerr;
        private readonly TitleAliases? _aliases;

        /// <summary>Creates the reader (DI; tests may pass no aliases).</summary>
        public SharedRequestFacts(RequestLedger ledger, SeerrFacts seerr, TitleAliases? aliases)
        {
            _ledger = ledger;
            _seerr = seerr;
            _aliases = aliases;
        }

        /// <summary>True when the watchlist features read these facts: phase 3 on with JE or Seerr request handling.</summary>
        public static bool Active(PluginConfiguration? config)
            => EffectiveRequestsBackend.IsStrictJe(config) || config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true } && config.ArrRequestBackend is "je" or "seerr";

        /// <summary>True when Jellyfin Enhanced handles requests (the ledger is the authority; Seerr isn't needed).</summary>
        public static bool LedgerAuthority(PluginConfiguration? config) => EffectiveRequestsBackend.IsStrictJe(config) || Active(config) && config!.ArrRequestBackend == "je";

        private static bool Asked(RequestWant want) => want.Status is not ("cancelled" or "declined");

        private IEnumerable<TitleKey> Keys(TitleKey key)
        {
            var canonical = _aliases?.Canonical(key) ?? key;
            return new[] { key, canonical }.Concat(_aliases?.Of(key) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>())
                .Where(k => k.IsMovie == key.IsMovie).Select(k => k.Title).Distinct();
        }

        /// <summary>Who asked for a title.</summary>
        /// <param name="config">The current configuration.</param>
        /// <param name="key">The title (any provider id; aliases are followed).</param>
        public TitleRequesters For(PluginConfiguration config, TitleKey key)
            => LedgerAuthority(config) ? ForCore(config, key)
                : Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.ReadSeerrCached(() => ForCore(config, key), new TitleRequesters(false, Array.Empty<Guid>()));

        private TitleRequesters ForCore(PluginConfiguration config, TitleKey key)
        {
            if (LedgerAuthority(config))
            {
                if (!_ledger.Database.Available) return new TitleRequesters(false, Array.Empty<Guid>());
                var users = Keys(key).SelectMany(k => _ledger.ForTitle(k.ToString())).Where(Asked).Select(w => w.UserId).Distinct().ToList();
                return new TitleRequesters(true, users);
            }
            if (!SeerrComplete(out var floor)) return new TitleRequesters(false, Array.Empty<Guid>());
            var records = Keys(key).SelectMany(k => _seerr.ForTitle(k)).Where(r => r.Active).ToList();
            var known = records.Where(r => r.RequestedBy.HasValue).Select(r => r.RequestedBy!.Value).Distinct().ToList();
            // Seerr holds more requests than are read: anyone may have an older request for the title below
            // the floor, whether or not a newer one was read.
            return floor != null ? new TitleRequesters(false, known, Truncated: true) : new TitleRequesters(true, known);
        }

        /// <summary>What one person asked for.</summary>
        /// <param name="config">The current configuration.</param>
        /// <param name="user">The person.</param>
        public UserRequestedTitles ForUser(PluginConfiguration config, Guid user)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Compose(() => ForUserFactsCore(config, user));

        private UserRequestedTitles ForUserFactsCore(PluginConfiguration config, Guid user)
            => LedgerAuthority(config) ? ForUserCore(config, user)
                : Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.ReadSeerrCached(() => ForUserCore(config, user), new UserRequestedTitles(false, Array.Empty<(bool, int)>()));

        private UserRequestedTitles ForUserCore(PluginConfiguration config, Guid user)
        {
            if (LedgerAuthority(config))
            {
                if (!_ledger.Database.Available) return new UserRequestedTitles(false, Array.Empty<(bool, int)>());
                var titles = new List<(bool, int)>();
                foreach (var want in _ledger.List(user, false).Where(Asked))
                {
                    if (TitleKey.Parse(want.Input.Key) is not { } key) continue;
                    var tmdb = Keys(key).FirstOrDefault(k => k.Provider == "tmdb")?.NumericId;
                    if (tmdb is int id) titles.Add((key.IsMovie, id));
                }
                return new UserRequestedTitles(true, titles.Distinct().ToList());
            }
            if (!SeerrComplete(out var floor) || floor != null) return new UserRequestedTitles(false, Array.Empty<(bool, int)>());
            return new UserRequestedTitles(true, _seerr.ForUser(user).Where(r => r.Active && r.TmdbId > 0).Select(r => (r.IsMovie, r.TmdbId!.Value)).Distinct().ToList());
        }

        // The read model has a complete read of the configured Seerr (not loading, not mid-failure).
        private bool SeerrComplete(out int? floor)
        {
            floor = null;
            if (!_seerr.Active || !_seerr.Loaded) return false;
            var state = _seerr.State;
            if (state.IncompleteReason != null || state.LastError != null) return false;
            var current = _seerr.Current;
            if (current.Source == null) return false;
            floor = current.Floor;
            return true;
        }

        /// <summary>The canonical key of a Jellyfin movie or series from its provider ids, or null.</summary>
        /// <param name="movie">True for a movie.</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <param name="tvdb">TVDB id (series).</param>
        /// <param name="imdb">IMDb id.</param>
        public static TitleKey? KeyOf(bool movie, int? tmdb, string? tvdb, string? imdb)
            => movie ? TitleKey.ForMovie(tmdb?.ToString(CultureInfo.InvariantCulture), imdb) : TitleKey.ForSeries(tvdb, tmdb?.ToString(CultureInfo.InvariantCulture), imdb);
    }
}

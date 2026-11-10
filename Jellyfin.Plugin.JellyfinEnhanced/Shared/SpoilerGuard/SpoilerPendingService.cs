using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard
{
    /// <summary>
    /// Spoiler Guard's pre-acquisition pending write path (restructure S2.13, moved verbatim from
    /// JellyfinEnhancedController): library lookup + read-modify-write of spoilerblur.json. Used by Spoiler Guard's
    /// <c>spoiler-blur/pending</c> route and by the Seerr request route's auto-enable hook, so it lives in
    /// Shared/SpoilerGuard (backend.md §7.7). Built with <c>new</c> by both controllers; no DI registration.
    /// Reads no <c>User</c>: the callers resolve and authorize the user.
    /// </summary>
    public sealed class SpoilerPendingService
    {
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly Logger _logger;
        private readonly UserDisplayResolver _userDisplayResolver;
        private readonly LibraryItemLookup _libraryItemLookup;

        public SpoilerPendingService(UserConfigurationManager userConfigurationManager, Logger logger, UserDisplayResolver userDisplayResolver, LibraryItemLookup libraryItemLookup)
        {
            _userConfigurationManager = userConfigurationManager;
            _logger = logger;
            _userDisplayResolver = userDisplayResolver;
            _libraryItemLookup = libraryItemLookup;
        }

        // Shared core for the manual modal-button POST and the auto-on-Seerr-request
        // hook: library lookup + RMW, returning a structured result both the HTTP
        // layer and the fire-and-forget log layer can reason about.
        public SpoilerBlurPendingResult AddSpoilerBlurPendingInternal(
            Guid userId,
            Jellyfin.Database.Implementations.Entities.User jUser,
            string mediaType,
            string canonicalTmdb,
            string? displayName)
        {
            var pendingKey = $"{mediaType}:{canonicalTmdb}";
            var userKey = userId.ToString("N");
            var fileName = Features.SpoilerGuard.Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var existingItem = _libraryItemLookup.FindLibraryItemByTmdb(jUser, mediaType, canonicalTmdb);

            if (existingItem is MediaBrowser.Controller.Entities.TV.Series existingSeries)
            {
                var seriesKey = existingSeries.Id.ToString("N");
                var changed = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        if (state.Series.ContainsKey(seriesKey)) return pendingRemoved ? 1 : 0;
                        state.Series[seriesKey] = new SpoilerBlurSeriesEntry
                        {
                            SeriesId = seriesKey,
                            SeriesName = existingSeries.Name ?? string.Empty,
                            EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                // The pending row (if any) was just consumed — keep the
                // promoter's gate consistent so it stops sweeping this user.
                Shared.SpoilerGuard.SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId);
                _logger.Info($"Spoiler Guard pending resolved to existing series '{existingSeries.Name}' ({seriesKey}) for {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return new SpoilerBlurPendingResult("series", seriesKey, existingSeries.Name, changed > 0);
            }
            if (existingItem is MediaBrowser.Controller.Entities.Movies.Movie existingMovie)
            {
                var movieKey = existingMovie.Id.ToString("N");
                var changed = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        if (state.Movies.ContainsKey(movieKey)) return pendingRemoved ? 1 : 0;
                        state.Movies[movieKey] = new SpoilerBlurMovieEntry
                        {
                            MovieId = movieKey,
                            MovieName = existingMovie.Name ?? string.Empty,
                            EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                Shared.SpoilerGuard.SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId);
                _logger.Info($"Spoiler Guard pending resolved to existing movie '{existingMovie.Name}' ({movieKey}) for {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return new SpoilerBlurPendingResult("movie", movieKey, existingMovie.Name, changed > 0);
            }

            var sanitized = SanitizePendingDisplayName(displayName);
            var capExceeded = new[] { false };
            var pendingChanged = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    if (state.PendingTmdb.TryGetValue(pendingKey, out var existing))
                    {
                        if (string.Equals(existing.DisplayName, sanitized, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.DisplayName = sanitized;
                        return 1;
                    }
                    if (state.PendingTmdb.Count >= MaxPendingTmdbPerUser)
                    {
                        capExceeded[0] = true;
                        return 0;
                    }
                    state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry
                    {
                        MediaType = mediaType,
                        TmdbId = canonicalTmdb,
                        DisplayName = sanitized,
                        RequestedAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            if (capExceeded[0])
            {
                _logger.Warning($"Spoiler Guard pending: cap of {MaxPendingTmdbPerUser} reached for {_userDisplayResolver.ResolveUserDisplay(userKey)} — rejecting new {pendingKey}");
                return new SpoilerBlurPendingResult("cap-exceeded", null, null, false);
            }
            // Prime the promoter's fast-path gate so the next ItemAdded
            // matching this TMDB id sweeps THIS user instead of bailing.
            Shared.SpoilerGuard.SpoilerSeerrPendingPromoter.RegisterPending(pendingKey, userId);
            _logger.Info($"Spoiler Guard pending recorded {pendingKey} for {_userDisplayResolver.ResolveUserDisplay(userKey)} (not yet in library)");

            // TOCTOU recovery: the scanner may have added the item between the
            // top-of-method lookup and this write — ItemAdded fired before our
            // pending row existed, so the promoter skipped this user. Re-check
            // once and promote inline if so.
            try
            {
                var raceItem = _libraryItemLookup.FindLibraryItemByTmdb(jUser, mediaType, canonicalTmdb);
                if (raceItem is MediaBrowser.Controller.Entities.TV.Series rs)
                {
                    return PromotePendingToSeries(userKey, fileName, rs, pendingKey);
                }
                if (raceItem is MediaBrowser.Controller.Entities.Movies.Movie rm)
                {
                    return PromotePendingToMovie(userKey, fileName, rm, pendingKey);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Spoiler Guard pending TOCTOU recheck threw {ex.GetType().Name}: {ex.Message}");
            }
            return new SpoilerBlurPendingResult("pending", null, null, pendingChanged > 0);
        }

        // TOCTOU recovery helper: a pending row was just written but a
        // matching library item is already present. Promote into Series.
        private SpoilerBlurPendingResult PromotePendingToSeries(
            string userKey, string fileName,
            MediaBrowser.Controller.Entities.TV.Series series, string pendingKey)
        {
            var seriesKey = series.Id.ToString("N");
            _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                    if (state.Series.ContainsKey(seriesKey)) return pendingRemoved ? 1 : 0;
                    state.Series[seriesKey] = new SpoilerBlurSeriesEntry
                    {
                        SeriesId = seriesKey,
                        SeriesName = series.Name ?? string.Empty,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            // Pending row consumed inline — release the promoter's gate for
            // this user (harmless no-op if it was never registered).
            if (Guid.TryParseExact(userKey, "N", out var promotedSeriesUserId))
            {
                Shared.SpoilerGuard.SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, promotedSeriesUserId);
            }
            _logger.Info($"Spoiler Guard pending TOCTOU-promoted to series '{series.Name}' ({seriesKey}) for {_userDisplayResolver.ResolveUserDisplay(userKey)}");
            return new SpoilerBlurPendingResult("series", seriesKey, series.Name, true);
        }

        private SpoilerBlurPendingResult PromotePendingToMovie(
            string userKey, string fileName,
            MediaBrowser.Controller.Entities.Movies.Movie movie, string pendingKey)
        {
            var movieKey = movie.Id.ToString("N");
            _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                    if (state.Movies.ContainsKey(movieKey)) return pendingRemoved ? 1 : 0;
                    state.Movies[movieKey] = new SpoilerBlurMovieEntry
                    {
                        MovieId = movieKey,
                        MovieName = movie.Name ?? string.Empty,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            if (Guid.TryParseExact(userKey, "N", out var promotedMovieUserId))
            {
                Shared.SpoilerGuard.SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, promotedMovieUserId);
            }
            _logger.Info($"Spoiler Guard pending TOCTOU-promoted to movie '{movie.Name}' ({movieKey}) for {_userDisplayResolver.ResolveUserDisplay(userKey)}");
            return new SpoilerBlurPendingResult("movie", movieKey, movie.Name, true);
        }

        public sealed record SpoilerBlurPendingResult(string Promoted, string? JellyfinId, string? Name, bool WroteSomething);

        // Clamp + strip control / format chars so a poisoned modal
        // payload can't grow spoilerblur.json without bound or sneak null
        // bytes / bidi-override (U+202E) tricks through the JSON
        // serializer + management UI. Strips Unicode Cf (Format) and Cc
        // (Control) categories explicitly so RTL spoofing
        // (e.g. `‮gnP.exe`) is neutralized. Truncates surrogate-pair-
        // safe so we don't emit lone surrogates that round-trip as U+FFFD
        // through Newtonsoft.
        private static string SanitizePendingDisplayName(string? raw)
        {
            if (string.IsNullOrEmpty(raw)) return string.Empty;
            const int max = 200;
            int end = raw.Length > max ? max : raw.Length;
            if (end > 0 && end < raw.Length && char.IsHighSurrogate(raw[end - 1]))
            {
                end -= 1;
            }
            var s = raw.Substring(0, end);
            var buf = new System.Text.StringBuilder(s.Length);
            foreach (var c in s)
            {
                if (c == '\r' || c == '\n' || c == '\t') { buf.Append(' '); continue; }
                var cat = System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c);
                if (cat == System.Globalization.UnicodeCategory.Control
                    || cat == System.Globalization.UnicodeCategory.Format)
                {
                    continue;
                }
                buf.Append(c);
            }
            return buf.ToString().Normalize(System.Text.NormalizationForm.FormC);
        }

        // Hard cap on PendingTmdb — defensive against an auth'd user spamming the
        // modal/Seerr hook to grow spoilerblur.json without bound. 500 is well above
        // any real watchlist. Reaching it rejects NEW inserts only; existing entries
        // still promote and DELETE still works, so users can prune to recover.
        public const int MaxPendingTmdbPerUser = 500;
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The Logos tag group's data: which logos an item gets (provider, network
    /// or studio, per the administrator's mode), projected into cache entries
    /// from <see cref="TagLogoService"/>'s stored lookups and Jellyfin's studio
    /// names without network I/O, plus the bounded TMDB warming before builds,
    /// reconciles and batch lookups.
    /// </summary>
    public partial class TagCacheService
    {
        private readonly TagLogoService? _logoService;
        private static readonly TimeSpan LogoDemandTtl = TimeSpan.FromMinutes(1);
        private long _logoDemandCheckedTicks;
        private volatile bool _logoDemand;
        private string _logoFingerprint = string.Empty;
        private Task _logoRefreshQueue = Task.CompletedTask;
        private readonly object _logoRefreshLock = new();

        /// <summary>Request-path warming waits at most this long; the rest finishes in the background.</summary>
        private static readonly TimeSpan LogoRequestBudget = TimeSpan.FromSeconds(3);

        /// <summary>Longer names show as an initialism on text chips (web and native).</summary>
        public const int LogoTextMaxLength = 12;

        /// <summary>
        /// True while anyone can see the Logos group: the administrator's default
        /// or at least one user has it on, and a mode is not off. Re-read at most
        /// once a minute, and at once after a settings save
        /// (<see cref="OnLogoSettingsChanged"/>).
        /// </summary>
        internal bool HasLogoDemand()
        {
            var now = DateTime.UtcNow.Ticks;
            if (now - Interlocked.Read(ref _logoDemandCheckedTicks) < LogoDemandTtl.Ticks) return _logoDemand;
            _logoDemand = ComputeLogoDemand();
            Interlocked.Exchange(ref _logoDemandCheckedTicks, now);
            return _logoDemand;
        }

        private bool ComputeLogoDemand()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return false;
            if (LogoTagRules.MovieMode(config.LogoTagsMovieMode) == LogoTagRules.Off && LogoTagRules.SeriesMode(config.LogoTagsSeriesMode) == LogoTagRules.Off) return false;
            if (config.LogoTagsEnabled) return true;
            var users = new UserConfigurationManager(_applicationPaths, _logger);
            return users.GetAllUserIds().Any(id => users.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json").LogoTagsEnabled);
        }

        /// <summary>
        /// A user or the administrator saved settings: re-check who shows the
        /// Logos group and the administrator's logo choices, and when either
        /// changed, warm the new lookups and republish every entry's logos in the
        /// background (strictly in save order, never blocking the save).
        /// </summary>
        internal void OnLogoSettingsChanged()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return;
            var demand = ComputeLogoDemand();
            var fingerprint = demand + "|" + LogoTagRules.Fingerprint(config);
            Interlocked.Exchange(ref _logoDemandCheckedTicks, DateTime.UtcNow.Ticks);
            var changed = fingerprint != _logoFingerprint;
            _logoDemand = demand;
            _logoFingerprint = fingerprint;
            if (!changed || _cacheReleased || !ServerModeEnabled) return;
            lock (_logoRefreshLock)
            {
                _logoRefreshQueue = _logoRefreshQueue.ContinueWith(_ =>
                {
                    try
                    {
                        // The lookups run outside the rebuild lock (they can take minutes on
                        // a large library); only the republish needs it.
                        if (ShouldAbortCacheWork || _cacheReleased) return;
                        WarmLogos(CancellationToken.None);
                        _rebuildLock.Wait();
                        try
                        {
                            if (ShouldAbortCacheWork || _cacheReleased) return;
                            RefreshLogos();
                        }
                        finally
                        {
                            _rebuildLock.Release();
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[LogoTags] Refreshing logos after a settings change failed: {ex.Message}");
                    }
                }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
            }
        }

        /// <summary>
        /// Record the logo settings the cache's entries were built with (after a
        /// disk load or a full build), so the next save only refreshes on a change.
        /// </summary>
        private void NoteLogoBaseline()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return;
            _logoDemand = ComputeLogoDemand();
            Interlocked.Exchange(ref _logoDemandCheckedTicks, DateTime.UtcNow.Ticks);
            _logoFingerprint = _logoDemand + "|" + LogoTagRules.Fingerprint(config);
        }

        /// <summary>The Movie or Series an item's logos come from (seasons and episodes use their series).</summary>
        private BaseItem? LogoOwner(BaseItem item, BaseItem? series)
        {
            if (item is Season or Episode) return series ?? GetParentSeries(item);
            return item is Movie or Series ? item : null;
        }

        /// <summary>The administrator's mode for a logo owner.</summary>
        private static string LogoMode(BaseItem owner, PluginConfiguration config) =>
            owner is Series ? LogoTagRules.SeriesMode(config.LogoTagsSeriesMode) : LogoTagRules.MovieMode(config.LogoTagsMovieMode);

        private static string? TmdbIdOf(BaseItem item) =>
            item.ProviderIds?.TryGetValue("Tmdb", out var id) == true && TagLogoService.IsValidId(id) ? id : null;

        /// <summary>
        /// The logos an item's cache entry and batch lookup carry, from stored
        /// lookups and Jellyfin's studio names only (no network I/O); null when
        /// nobody shows the group, the mode is off, or nothing is known.
        /// </summary>
        public TagLogo[]? GetLogos(BaseItem item, BaseItem? series = null)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !HasLogoDemand()) return null;
            var owner = LogoOwner(item, series);
            return owner == null ? null : ResolveLogos(owner, config, _logoService);
        }

        /// <summary>
        /// Provider mode: the region's flat-rate providers when a lookup has them,
        /// else (no key, no lookup yet, nothing streaming) the studio or network
        /// as in that mode. Network/studio mode: Jellyfin's studio names, each
        /// with the TMDB company/network logo of the same name when the details
        /// lookup has one; TMDB's own list when Jellyfin has no studios.
        /// </summary>
        internal static TagLogo[]? ResolveLogos(BaseItem owner, PluginConfiguration config, TagLogoService? logos)
        {
            var mode = LogoMode(owner, config);
            if (mode == LogoTagRules.Off) return null;
            var max = LogoTagRules.Max(config.LogoTagsMaxLogos);
            var mediaType = owner is Series ? "tv" : "movie";
            var tmdbId = TmdbIdOf(owner);
            var region = LogoTagRules.Region(config);
            if (mode == LogoTagRules.Provider && tmdbId != null && logos != null
                && logos.TryGet(mediaType, tmdbId, TagLogoService.LookupKind.Providers, region, out var providers) && providers.Items.Length > 0)
            {
                return providers.Items.Take(max).Select(p => new TagLogo { Kind = LogoTagRules.Provider, Name = p.Name, Logo = p.Logo }).ToArray();
            }

            var kind = owner is Series ? LogoTagRules.Network : LogoTagRules.Studio;
            TagLogoService.LogoRef[] known = Array.Empty<TagLogoService.LogoRef>();
            if (tmdbId != null && logos != null && logos.TryGet(mediaType, tmdbId, TagLogoService.LookupKind.Details, region, out var details)) known = details.Items;
            var names = (owner.Studios ?? Array.Empty<string>()).Where(n => !string.IsNullOrWhiteSpace(n)).Select(n => n.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase).Take(max).ToArray();
            var result = names.Length > 0
                ? names.Select(name => new TagLogo { Kind = kind, Name = name, Logo = known.FirstOrDefault(k => SameName(k.Name, name))?.Logo }).ToArray()
                : known.Take(max).Select(k => new TagLogo { Kind = kind, Name = k.Name, Logo = k.Logo }).ToArray();
            return result.Length > 0 ? result : null;
        }

        /// <summary>Studio names compare without case, spaces or punctuation ("Warner Bros." = "Warner Bros").</summary>
        internal static bool SameName(string a, string b)
        {
            static string Key(string s) => new string(s.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
            return Key(a) == Key(b);
        }

        /// <summary>The lookups an owner needs: providers in provider mode, details otherwise (and when no provider streams it).</summary>
        private IEnumerable<(string MediaType, string TmdbId, TagLogoService.LookupKind Kind)> LogoLookups(BaseItem owner, PluginConfiguration config, bool fallbackPass)
        {
            var tmdbId = TmdbIdOf(owner);
            var mode = LogoMode(owner, config);
            if (tmdbId == null || mode == LogoTagRules.Off) yield break;
            var mediaType = owner is Series ? "tv" : "movie";
            if (mode != LogoTagRules.Provider)
            {
                yield return (mediaType, tmdbId, TagLogoService.LookupKind.Details);
                yield break;
            }

            if (!fallbackPass)
            {
                yield return (mediaType, tmdbId, TagLogoService.LookupKind.Providers);
            }
            else if (_logoService != null && _logoService.TryGet(mediaType, tmdbId, TagLogoService.LookupKind.Providers, LogoTagRules.Region(config), out var providers)
                && !providers.Failed && providers.Items.Length == 0)
            {
                yield return (mediaType, tmdbId, TagLogoService.LookupKind.Details);
            }
        }

        /// <summary>
        /// Warm the lookups and logo images of these owners (two passes: providers,
        /// then details for titles nothing streams). No key, no demand: nothing.
        /// </summary>
        private async Task WarmLogoOwnersAsync(IReadOnlyCollection<BaseItem> owners, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (_logoService == null || config == null || owners.Count == 0 || string.IsNullOrWhiteSpace(config.TMDB_API_KEY) || !HasLogoDemand()) return;
            var region = LogoTagRules.Region(config);
            await _logoService.WarmAsync(config.TMDB_API_KEY, owners.SelectMany(o => LogoLookups(o, config, false)), region, cancellationToken).ConfigureAwait(false);
            await _logoService.WarmAsync(config.TMDB_API_KEY, owners.SelectMany(o => LogoLookups(o, config, true)), region, cancellationToken).ConfigureAwait(false);
            var paths = owners.SelectMany(o => ResolveLogos(o, config, _logoService) ?? Array.Empty<TagLogo>()).Select(l => l.Logo);
            await _logoService.WarmImagesAsync(paths, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// Batch lookups and single-item rebuilds: warm the requested items'
        /// owners, waiting at most <see cref="LogoRequestBudget"/> (the rest
        /// completes in the background and reaches later requests).
        /// </summary>
        public void WarmLogosForItems(IEnumerable<BaseItem> items, CancellationToken cancellationToken)
        {
            if (_logoService == null || !HasLogoDemand()) return;
            var owners = items.Select(item => LogoOwner(item, null)).Where(o => o != null).Select(o => o!)
                .GroupBy(o => o.Id).Select(g => g.First()).ToArray();
            if (owners.Length == 0) return;
            try
            {
                WarmLogoOwnersAsync(owners, CancellationToken.None).Wait(LogoRequestBudget, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // The caller went away; the warm continues for the next request.
            }
            catch (AggregateException ex)
            {
                _logger.Debug($"[LogoTags] Warming logos failed: {ex.InnerException?.Message ?? ex.Message}");
            }
        }

        /// <summary>Full builds and reconciles: warm every movie and series due for a lookup.</summary>
        private void WarmLogos(CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (_logoService == null || config == null || string.IsNullOrWhiteSpace(config.TMDB_API_KEY) || !HasLogoDemand()) return;
            try
            {
                var owners = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                    IsVirtualItem = false,
                    Recursive = true,
                }).Where(item => !IsInExcludedLibrary(item)).ToArray();
                WarmLogoOwnersAsync(owners, cancellationToken).GetAwaiter().GetResult();
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[LogoTags] Warming logos failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Republish every entry's logos from the stored lookups (after a warm or
        /// a settings change), under the caller's rebuild lock. Seasons and
        /// episodes take their series' logos.
        /// </summary>
        private void RefreshLogos()
        {
            if (_cacheReleased) return;
            using var writes = BeginInPlaceWrites();
            var changed = false;
            var byOwner = new Dictionary<Guid, TagLogo[]?>();
            TagLogo[]? LogosOf(Guid ownerId)
            {
                if (byOwner.TryGetValue(ownerId, out var memo)) return memo;
                var owner = ownerId == Guid.Empty ? null : _libraryManager.GetItemById(ownerId);
                return byOwner[ownerId] = owner == null ? null : GetLogos(owner);
            }

            foreach (var pair in _cache)
            {
                var entry = pair.Value;
                if (entry.Type is not ("Movie" or "Series" or "Season" or "Episode")) continue;
                Guid ownerId;
                if (entry.Type is "Season" or "Episode") Guid.TryParse(entry.SeriesId, out ownerId);
                else Guid.TryParse(pair.Key, out ownerId);
                var logos = LogosOf(ownerId);
                if (TagLogo.SequencesEqual(logos, entry.Logos)) continue;
                var updated = entry.Clone();
                updated.Logos = logos;
                updated.LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                RaiseMaxLastUpdated(updated.LastUpdated);
                StoreEntry(pair.Key, updated);
                changed = true;
            }

            if (!changed) return;
            Interlocked.Increment(ref _version);
            Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            ScheduleDebouncedSave();
        }
    }
}

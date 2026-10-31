using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Projects daily movie keyword snapshots into the normal tag-cache publication.</summary>
public partial class TagCacheService
{
    private readonly StatusTagsScenesService? _scenesService;
    private readonly object _scenesLock = new();
    private Task _scenesWork = Task.CompletedTask;
    private string _scenesConfig = string.Empty;

    /// <summary>Movie-only, cache-only facts for web batch and native resolution.</summary>
    public TagScenes? GetScenes(BaseItem item)
    {
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (item is not Movie || config?.StatusTagsEnabled != true || !config.StatusTagsScenes || string.IsNullOrWhiteSpace(config.TMDB_API_KEY)) return null;
        var id = TmdbIdOf(item);
        if (id == null) return null;
        return _scenesService?.Get(config.TMDB_API_KEY, id)
            ?? (_cache.TryGetValue(item.Id.ToString("N"), out var old) && old.TmdbId == id ? old.Scenes : null);
    }

    /// <summary>Warm accessible batch items outside image composition, with a bounded request wait.</summary>
    public void WarmScenesForItems(IEnumerable<BaseItem> items, CancellationToken cancellationToken)
    {
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (_scenesService == null || config?.StatusTagsEnabled != true || !config.StatusTagsScenes) return;
        try
        {
            _scenesService.WarmAsync(config.TMDB_API_KEY, items.OfType<Movie>().Select(TmdbIdOf).OfType<string>().ToArray(), CancellationToken.None)
                .Wait(TimeSpan.FromSeconds(3), cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (AggregateException ex) { _logger.Debug($"[StatusTags] Keyword warm failed: {ex.GetType().Name}"); }
    }

    private void WarmScenes(CancellationToken cancellationToken)
    {
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (_scenesService == null || config?.StatusTagsEnabled != true || !config.StatusTagsScenes || string.IsNullOrWhiteSpace(config.TMDB_API_KEY)) return;
        var movies = _libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.Movie }, Recursive = true, IsVirtualItem = false })
            .Where(item => !IsInExcludedLibrary(item)).Select(TmdbIdOf).OfType<string>().ToArray();
        _scenesService.WarmAsync(config.TMDB_API_KEY, movies, cancellationToken).GetAwaiter().GetResult();
    }

    /// <summary>Enabling Scenes or changing its provider queues a refresh, leaving configuration saves nonblocking.</summary>
    internal void OnScenesSettingsChanged()
    {
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (config == null) return;
        lock (_scenesLock)
        {
            var fingerprint = config.StatusTagsEnabled + "|" + config.StatusTagsScenes + "|" + config.TMDB_API_KEY;
            if (fingerprint == _scenesConfig) return;
            _scenesConfig = fingerprint;
            _scenesWork = _scenesWork.ContinueWith(_ =>
            {
                try
                {
                    if (_disposed || _cacheReleased || !ServerModeEnabled) return;
                    WarmScenes(CancellationToken.None);
                    _rebuildLock.Wait();
                    try { if (!_disposed && !_cacheReleased) RefreshScenes(); }
                    finally { _rebuildLock.Release(); }
                }
                catch (Exception ex) { _logger.Debug($"[StatusTags] Keyword refresh failed: {ex.GetType().Name}"); }
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
        }
    }

    private void RefreshScenes()
    {
        using var writes = BeginInPlaceWrites();
        bool changed = false;
        foreach (var pair in _cache)
        {
            if (pair.Value.Type != "Movie" || !Guid.TryParse(pair.Key, out var id)) continue;
            var movie = _libraryManager.GetItemById(id);
            var scenes = movie == null ? null : GetScenes(movie);
            if (scenes == pair.Value.Scenes) continue;
            var updated = pair.Value.Clone();
            updated.Scenes = scenes;
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

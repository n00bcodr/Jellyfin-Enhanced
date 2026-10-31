using System.Collections.Concurrent;
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
    private readonly CancellationTokenSource _scenesLifetime = new();
    private readonly ConcurrentDictionary<string, byte> _pendingScenes = new(StringComparer.Ordinal);
    private bool _scenesQueued;
    private sealed record ScenesProjection(string? TmdbId, TagScenes? Facts);
    // Includes native on-demand reads when there is no published server cache.
    private readonly ConcurrentDictionary<Guid, ScenesProjection> _scenesProjections = new();

    /// <summary>Gather card reads before one background pass.</summary>
    internal TimeSpan ScenesRefreshDelay { get; set; } = TimeSpan.FromSeconds(2);
    internal int PendingScenesRefreshes => _pendingScenes.Count;
    internal Task ScenesWorkQueue { get { lock (_scenesLock) return _scenesWork; } }
    internal event Action<IReadOnlyCollection<Guid>>? ScenesRefreshed;

    /// <summary>Movie-only, cache-only facts for web batch and native resolution.</summary>
    public TagScenes? GetScenes(BaseItem item)
    {
        if (item is not Movie) return null;
        var scenes = ReadScenes(item);
        var tmdbId = TmdbIdOf(item);
        _scenesProjections.AddOrUpdate(item.Id, new ScenesProjection(tmdbId, scenes),
            (_, old) => old.TmdbId == tmdbId ? old : new(tmdbId, scenes));
        QueueScenesRefresh(new[] { item });
        return scenes;
    }

    /// <summary>Read the current projection without queuing work or replacing its publication baseline.</summary>
    private TagScenes? ReadScenes(BaseItem item) => item is Movie ? ReadScenes(item.Id, TmdbIdOf(item)) : null;

    private TagScenes? ReadScenes(Guid movieId, string? id)
    {
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (config?.StatusTagsEnabled != true || !config.StatusTagsScenes || string.IsNullOrWhiteSpace(config.TMDB_API_KEY)) return null;
        if (id == null) return null;
        return _scenesService?.Get(config.TMDB_API_KEY, id)
            ?? (_cache.TryGetValue(movieId.ToString("N"), out var old) && old.TmdbId == id ? old.Scenes : null);
    }

    /// <summary>Cache-only reads gather due movie ids; the worker owns cancellation, never the card request.</summary>
    public void QueueScenesRefresh(IEnumerable<BaseItem> items)
    {
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (_scenesService == null || config?.StatusTagsEnabled != true || !config.StatusTagsScenes
            || string.IsNullOrWhiteSpace(config.TMDB_API_KEY) || _disposed) return;
        lock (_scenesLock)
        {
            if (_disposed) return;
            foreach (var id in items.OfType<Movie>().Select(TmdbIdOf).OfType<string>())
                if (_scenesService.IsDue(config.TMDB_API_KEY, id)) _pendingScenes.TryAdd(id, 0);
            if (_pendingScenes.IsEmpty || _scenesQueued) return;
            _scenesQueued = true;
            _scenesWork = _scenesWork.ContinueWith(_ => RunScenesRefreshAsync(), CancellationToken.None,
                TaskContinuationOptions.None, TaskScheduler.Default).Unwrap();
        }
    }

    private async Task RunScenesRefreshAsync()
    {
        var token = _scenesLifetime.Token;
        try
        {
            await Task.Delay(ScenesRefreshDelay, token).ConfigureAwait(false);
            string[] ids;
            lock (_scenesLock)
            {
                ids = _pendingScenes.Keys.ToArray();
                _pendingScenes.Clear();
                _scenesQueued = false;
            }
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config?.StatusTagsEnabled != true || !config.StatusTagsScenes) return;
            await _scenesService!.WarmAsync(config.TMDB_API_KEY, ids, token).ConfigureAwait(false);
            await PublishScenesAsync(token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception ex) { _logger.Debug($"[StatusTags] Keyword refresh failed: {ex.GetType().Name}"); }
    }

    private async Task PublishScenesAsync(CancellationToken token)
    {
        await _rebuildLock.WaitAsync(token).ConfigureAwait(false);
        try { if (!_disposed) RefreshScenes(); }
        finally { _rebuildLock.Release(); }
        token.ThrowIfCancellationRequested();
    }

    private void StopScenesRefresh()
    {
        _scenesLifetime.Cancel();
        lock (_scenesLock) { _pendingScenes.Clear(); _scenesQueued = false; }
    }

    private void WarmScenes(CancellationToken cancellationToken)
    {
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (_scenesService == null || config?.StatusTagsEnabled != true || !config.StatusTagsScenes || string.IsNullOrWhiteSpace(config.TMDB_API_KEY)) return;
        var movies = _libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.Movie }, Recursive = true, IsVirtualItem = false })
            .Where(item => !IsInExcludedLibrary(item)).Select(TmdbIdOf).OfType<string>().ToArray();
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _scenesLifetime.Token);
        _scenesService.WarmAsync(config.TMDB_API_KEY, movies, lifetime.Token).GetAwaiter().GetResult();
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
            _scenesWork = _scenesWork.ContinueWith(async _ =>
            {
                var token = _scenesLifetime.Token;
                try
                {
                    if (_disposed) return;
                    WarmScenes(token);
                    await PublishScenesAsync(token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { }
                catch (Exception ex) { _logger.Debug($"[StatusTags] Keyword refresh failed: {ex.GetType().Name}"); }
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default).Unwrap();
        }
    }

    private void RefreshScenes()
    {
        using var writes = BeginInPlaceWrites();
        var changedOwners = new HashSet<Guid>();
        foreach (var pair in _scenesProjections)
        {
            var scenes = ReadScenes(pair.Key, pair.Value.TmdbId);
            if (scenes == pair.Value.Facts) continue;
            _scenesProjections[pair.Key] = pair.Value with { Facts = scenes };
            changedOwners.Add(pair.Key);
        }

        bool changed = false;
        foreach (var pair in _cache)
        {
            if (pair.Value.Type != "Movie" || !Guid.TryParse(pair.Key, out var id)) continue;
            var movie = _libraryManager.GetItemById(id);
            var scenes = movie == null ? null : ReadScenes(movie);
            if (scenes == pair.Value.Scenes) continue;
            var updated = pair.Value.Clone();
            updated.Scenes = scenes;
            updated.LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            RaiseMaxLastUpdated(updated.LastUpdated);
            StoreEntry(pair.Key, updated);
            changed = true;
            changedOwners.Add(id);
        }
        if (changed)
        {
            Interlocked.Increment(ref _version);
            Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            ScheduleDebouncedSave();
        }
        if (changedOwners.Count > 0) ScenesRefreshed?.Invoke(changedOwners);
    }
}

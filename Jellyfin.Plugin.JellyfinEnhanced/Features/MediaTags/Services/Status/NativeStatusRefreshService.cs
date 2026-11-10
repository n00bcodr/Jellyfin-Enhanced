using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Extensions.Hosting;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;

/// <summary>Refreshes public native status snapshots off the image route, on stale reads and once a minute.</summary>
public sealed class NativeStatusRefreshService : BackgroundService
{
    private const int MaxSeries = 512;
    // Schedules refresh in batches: the series service runs a batch under its own in-flight and rate
    // limits, and each batch publishes before the next starts, so cards fill in as the queue drains.
    private const int SeriesBatch = 16;
    private readonly StatusTagsTrendingService _trending;
    private readonly StatusTagsSeriesService _series;
    private readonly Logger _logger;
    private readonly TimeProvider _clock;
    private readonly object _lock = new();
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly Dictionary<string, (SeriesSchedule? Value, DateTimeOffset Until)> _snapshots = new(StringComparer.Ordinal);
    private PluginConfiguration? _config;
    private bool _trendingMissLogged;

    public NativeStatusRefreshService(StatusTagsTrendingService trending, StatusTagsSeriesService series, Logger logger)
        : this(trending, series, logger, TimeProvider.System) { }

    internal NativeStatusRefreshService(StatusTagsTrendingService trending, StatusTagsSeriesService series, Logger logger, TimeProvider clock)
    {
        _trending = trending;
        _series = series;
        _logger = logger;
        _clock = clock;
    }

    private void SetConfig(PluginConfiguration config)
    {
        if (ReferenceEquals(config, _config)) return;
        _config = config;
        _snapshots.Clear();
        _trendingMissLogged = false;
    }

    private void RequestRefresh()
    {
        if (_wake.CurrentCount == 0) _wake.Release();
    }

    /// <summary>Immediately omit a missing or expired daily rank; coalesce the background refresh signal.</summary>
    public TrendingSnapshot GetTrending(PluginConfiguration config)
    {
        lock (_lock)
        {
            SetConfig(config);
            if (_trending.TryGetNative(config, out var snapshot)) return snapshot;
            if (!_trendingMissLogged)
            {
                _logger.Debug("[StatusTags] Native trending snapshot cold/stale; omitting popular badge and queueing background refresh.");
                _trendingMissLogged = true;
            }
            RequestRefresh();
            return StatusTagsTrendingService.Empty;
        }
    }

    /// <summary>Immediately read a fresh schedule; bounded pending entries include five-minute failure suppression.</summary>
    public SeriesSchedule? GetSeries(PluginConfiguration config, string tmdbId)
    {
        if (string.IsNullOrWhiteSpace(config.TMDB_API_KEY)) return null;
        lock (_lock)
        {
            SetConfig(config);
            if (_snapshots.TryGetValue(tmdbId, out var snapshot) && snapshot.Until > _clock.GetUtcNow()) return snapshot.Value;
            if (!_snapshots.ContainsKey(tmdbId))
            {
                if (_snapshots.Count >= MaxSeries) _snapshots.Remove(_snapshots.Keys.First());
                _snapshots[tmdbId] = (null, DateTimeOffset.MinValue);
                _logger.Debug("[StatusTags] Native series snapshot cold/stale; omitting schedule badges and queueing background refresh.");
            }
            RequestRefresh();
            return null;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config != null) await RefreshAsync(config, stoppingToken).ConfigureAwait(false);
                await _wake.WaitAsync(TimeSpan.FromMinutes(1), stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    /// <summary>Only the worker performs remote work. Shared TMDB responses and flights remain authoritative.</summary>
    internal async Task RefreshAsync(PluginConfiguration config, CancellationToken cancellationToken)
    {
        string[] pending;
        lock (_lock)
        {
            SetConfig(config);
            pending = _snapshots.Where(p => p.Value.Until <= _clock.GetUtcNow()).Select(p => p.Key).ToArray();
        }
        if (!config.NativePosterTagsEnabled || !config.StatusTagsEnabled) return;
        try
        {
            await _trending.GetNativeAsync(config, cancellationToken, workerLifetime: cancellationToken).ConfigureAwait(false);
            lock (_lock) _trendingMissLogged = false;
            foreach (var batch in pending.Chunk(SeriesBatch))
            {
                cancellationToken.ThrowIfCancellationRequested();
                var result = await _series.GetAsync(config.TMDB_API_KEY, batch.ToDictionary(id => id, id => id, StringComparer.Ordinal), cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                lock (_lock)
                {
                    // A newer configuration cleared the queue; its own pass refreshes what it needs.
                    if (!ReferenceEquals(config, _config)) return;
                    var now = _clock.GetUtcNow();
                    foreach (var id in batch)
                    {
                        if (!_snapshots.ContainsKey(id)) continue;
                        result.TryGetValue(id, out var schedule);
                        _snapshots[id] = (schedule?.Retry == true ? null : schedule,
                            now.Add(schedule == null || schedule.Retry ? TimeSpan.FromMinutes(5) : TimeSpan.FromHours(6)));
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception ex) { _logger.Debug($"[StatusTags] Native background refresh failed: {ex.Message}"); }
    }
}

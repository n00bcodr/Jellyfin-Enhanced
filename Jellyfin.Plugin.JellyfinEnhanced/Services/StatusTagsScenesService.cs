using System.Collections.Concurrent;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Daily movie keyword snapshots through the shared TMDB response cache. Image routes only read snapshots.</summary>
public sealed class StatusTagsScenesService
{
    private sealed record Snapshot(TagScenes? Facts, DateTimeOffset Until);
    private readonly ConcurrentDictionary<string, Snapshot> _snapshots = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> _providerRetry = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly TmdbResponseCache _responses;
    private readonly Logger _logger;
    private readonly TimeProvider _clock;

    public StatusTagsScenesService(TmdbResponseCache responses, Logger logger) : this(responses, logger, TimeProvider.System) { }

    internal StatusTagsScenesService(TmdbResponseCache responses, Logger logger, TimeProvider clock) { _responses = responses; _logger = logger; _clock = clock; }

    /// <summary>Pure exact keyword mapping; names are not substring matched.</summary>
    internal static TagScenes Map(string json)
    {
        using var document = JsonDocument.Parse(json);
        if (!document.RootElement.TryGetProperty("keywords", out var list) || list.ValueKind != JsonValueKind.Array) throw new JsonException("Missing movie keywords array");
        bool post = false, mid = false;
        if (document.RootElement.TryGetProperty("keywords", out var keywords) && keywords.ValueKind == JsonValueKind.Array)
        {
            foreach (var keyword in keywords.EnumerateArray())
            {
                if (keyword.ValueKind != JsonValueKind.Object || !keyword.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String) continue;
                post |= name.GetString() == "aftercreditsstinger";
                mid |= name.GetString() == "duringcreditsstinger";
            }
        }
        return new(post, mid);
    }

    /// <summary>Cache-only lookup, retaining the last confirmed value during a transient failure.</summary>
    public TagScenes? Get(string apiKey, string id) => _snapshots.TryGetValue(apiKey + ":" + id, out var value) ? value.Facts : null;

    /// <summary>One bounded server-side pass; shared response caching deduplicates concurrent lookups.</summary>
    public async Task WarmAsync(string apiKey, IEnumerable<string> ids, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(apiKey)) return;
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_providerRetry.TryGetValue(apiKey, out var retry) && retry > _clock.GetUtcNow()) return;
            foreach (var id in ids.Distinct(StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!long.TryParse(id, out var numeric) || numeric <= 0) continue;
                var key = apiKey + ":" + id;
                var now = _clock.GetUtcNow();
                _snapshots.TryGetValue(key, out var old);
                if (old?.Until > now) continue;
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    timeout.CancelAfter(TimeSpan.FromSeconds(10));
                    var day = new DateTimeOffset(now.UtcDateTime.Date, TimeSpan.Zero);
                    var response = await _responses.GetAsync("movie/" + id + "/keywords", "", apiKey, timeout.Token, notBefore: day).ConfigureAwait(false);
                    if (!response.IsSuccess) throw new HttpRequestException("Movie keywords unavailable");
                    _snapshots[key] = new(Map(response.Content), day.AddDays(1));
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    _logger.Debug($"[StatusTags] Movie keyword refresh failed: {ex.GetType().Name}");
                    _snapshots[key] = new(old?.Facts, now.AddHours(1));
                    // A broken key or unreachable provider must not walk the whole library at ten seconds per title.
                    _providerRetry[apiKey] = now.AddHours(1);
                    return;
                }
            }
        }
        finally { _gate.Release(); }
    }
}

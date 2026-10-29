using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// Notices when a request arrived ("Requests &amp; downloads", phase 3): an open request whose part is in
    /// Jellyfin for the person who asked (the movie, or its 4K copy for a 4K ask; every requested episode of the
    /// requested seasons, as the Requests page judges them; each requested single episode) is marked fulfilled, so
    /// it reads "Ready" everywhere and is never marked stale. Judged by the status service exactly as the Requests
    /// page shows it, as the requester sees it (library access and parental limits included). Driven by the change
    /// feed (arr snapshot changes and Jellyfin's library arrivals bump the titles), with a sweep every ten minutes
    /// for anything missed (a restart, a title known by another id). Requests still waiting for an OK whose part
    /// arrived another way are closed the same way (their held allowance given back). "Keep getting new episodes"
    /// requests never end. Reads memory and the database; Sonarr episode lists are read through the arr snapshot
    /// store like any page read. Does nothing while phase 3 is off.
    /// </summary>
    public sealed class RequestFulfilment : IHostedService, IDisposable
    {
        private static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan FirstSweepAfter = TimeSpan.FromSeconds(30);
        private const int MaxPerSweep = 500;
        private const int MaxWatched = 10000;

        private readonly RequestLedger _ledger;
        private readonly ArrStatusService _status;
        private readonly IArrJellyfinView _view;
        private readonly ArrChangeFeed _feed;
        private readonly TitleAliases _aliases;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly SemaphoreSlim _round = new(1, 1);
        private CancellationTokenSource? _loop;
        private Task? _loopTask;
        private string? _epoch;
        private long? _cursor;
        private DateTimeOffset _nextSweep;
        private long _watchedRevision = long.MinValue;
        // Where the sweep got to: the last request of its previous page (null: start from the first).
        private RequestWant? _sweepAfter;
        // Every id an open request's title is known by -> the title key the request was stored under.
        private SeerrFacts.Derived<Dictionary<string, HashSet<string>>>? _watched;

        /// <summary>The service (DI).</summary>
        public RequestFulfilment(RequestLedger ledger, ArrStatusService status, IArrJellyfinView view, ArrChangeFeed feed, TitleAliases aliases, Logger logger)
            : this(ledger, status, view, feed, aliases, logger, null, null)
        {
        }

        /// <summary>The service with explicit configuration and clock (tests).</summary>
        internal RequestFulfilment(RequestLedger ledger, ArrStatusService status, IArrJellyfinView view, ArrChangeFeed feed, TitleAliases aliases, Logger? logger, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now)
        {
            _ledger = ledger;
            _status = status;
            _view = view;
            _feed = feed;
            _aliases = aliases;
            _logger = logger;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>Most open requests one sweep looks at; the next sweep goes on from there (tests set it lower).</summary>
        internal int SweepPage { get; set; } = MaxPerSweep;

        /// <summary>Phase 3 is on with a request backend and the database is there.</summary>
        public bool Enabled => SharedRequestFacts.Active(_config()) && _ledger.Database.Available;

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _loop = new CancellationTokenSource();
            _nextSweep = _now() + FirstSweepAfter;
            _loopTask = Task.Run(() => LoopAsync(_loop.Token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            if (_loop == null) return;
            _loop.Cancel();
            try
            {
                if (_loopTask != null) await _loopTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Stopping.
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            _loop?.Cancel();
            _loop?.Dispose();
            _round.Dispose();
        }

        private async Task LoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    if (!Enabled)
                    {
                        _cursor = null;
                        await Task.Delay(TimeSpan.FromSeconds(5), token).ConfigureAwait(false);
                        continue;
                    }
                    if (_cursor == null)
                    {
                        _epoch = _feed.Epoch;
                        _cursor = _feed.Cursor;
                    }
                    await _feed.WaitAsync(_cursor.Value, TimeSpan.FromSeconds(5), token).ConfigureAwait(false);
                    var due = ReadFeed();
                    if (_now() >= _nextSweep)
                    {
                        _nextSweep = _now() + SweepEvery;
                        await CheckAsync(null, token).ConfigureAwait(false);
                    }
                    else if (due.Count > 0)
                    {
                        await CheckAsync(due, token).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Requests: checking for arrived requests failed ({ex.GetType().Name}: {ex.Message}).");
                    try
                    {
                        await Task.Delay(TimeSpan.FromSeconds(5), token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                }
            }
        }

        /// <summary>The titles with open requests that the feed says changed since the last read (all of them after a reset).</summary>
        internal IReadOnlyCollection<string> ReadFeed()
        {
            using var publication = SeerrFacts.BeginPublication();
            if (_cursor == null)
            {
                _epoch = _feed.Epoch;
                _cursor = _feed.Cursor;
                return Array.Empty<string>();
            }
            var read = _feed.Read(_epoch, _cursor.Value);
            _epoch = _feed.Epoch;
            _cursor = read.Cursor;
            if (read.Reset)
            {
                _nextSweep = _now();
                return Array.Empty<string>();
            }
            var watched = Watched();
            var due = new HashSet<string>(StringComparer.Ordinal);
            foreach (var change in read.Changes)
            {
                if (ArrTitleKey.TitleOf(change.Key) is not { } title) continue;
                if (watched.TryGetValue(title, out var keys)) due.UnionWith(keys);
            }
            return publication.Publish<IReadOnlyCollection<string>>(() => due);
        }

        // The open requests' titles under every id they are known by, rebuilt when the ledger changed.
        private Dictionary<string, HashSet<string>> Watched()
        {
            var revision = _ledger.Revision;
            if (revision == _watchedRevision && _watched != null && _watched.TryRead(out var held)) return held;
            using var publication = SeerrFacts.BeginPublication();
            var map = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
            void Add(string id, string key)
            {
                if (!map.TryGetValue(id, out var set)) map[id] = set = new HashSet<string>(StringComparer.Ordinal);
                set.Add(key);
            }
            foreach (var key in _ledger.Unfulfilled(MaxWatched).Select(w => w.Input.Key).Distinct(StringComparer.Ordinal))
            {
                if (TitleKey.Parse(key) is not { } parsed) continue;
                Add(key, key);
                Add(_aliases.Canonical(parsed).ToString(), key);
                foreach (var alias in _aliases.Of(parsed)) Add(alias.Title.ToString(), key);
            }
            _watched = SeerrFacts.Remember(map);
            _watchedRevision = revision;
            return publication.Publish(() => map);
        }

        /// <summary>
        /// Looks at open requests (of <paramref name="titleKeys"/>, or for a sweep the next page of all of them, least
        /// recently changed first, starting over after the last) and marks the ones whose part is in Jellyfin fulfilled.
        /// Returns how many were.
        /// </summary>
        /// <param name="titleKeys">Title keys as requests store them, or null for a sweep.</param>
        /// <param name="cancellationToken">Stops the round.</param>
        internal async Task<int> CheckAsync(IEnumerable<string>? titleKeys, CancellationToken cancellationToken)
        {
            using var effect = SeerrFacts.BeginEffect(cancellationToken);
            if (!Enabled) return 0;
            await _round.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var wants = titleKeys == null
                    ? NextSweepPage()
                    : titleKeys.Distinct(StringComparer.Ordinal).SelectMany(k => _ledger.Unfulfilled(MaxPerSweep, k)).ToList();
                var done = 0;
                foreach (var want in wants)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    try
                    {
                        // Only the request exactly as it was checked: one changed meanwhile is judged again next time.
                        if (await ArrivedAsync(want, cancellationToken).ConfigureAwait(false) && _ledger.Fulfil(want.Id, _now(), want))
                        {
                            done++;
                            _feed.Bump(new[] { want.Input.Key, ArrTitleKey.UserRequests(want.UserId), ArrTitleKey.RequestsState });
                        }
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        _logger?.Warning($"Requests: could not check whether {want.Input.Key} arrived ({ex.GetType().Name}: {ex.Message}).");
                    }
                }
                if (done > 0) _logger?.Info($"Requests: {done} request(s) arrived in Jellyfin and are marked fulfilled.");
                return done;
            }
            finally
            {
                _round.Release();
            }
        }

        // A sweep's page: the open requests after where the previous sweep stopped, so requests that haven't arrived
        // never keep the newer ones from being looked at; after the last page it starts again from the first.
        private IReadOnlyList<RequestWant> NextSweepPage()
        {
            var page = _ledger.Unfulfilled(SweepPage, null, _sweepAfter);
            if (page.Count == 0 && _sweepAfter != null) page = _ledger.Unfulfilled(SweepPage);
            _sweepAfter = page.Count < SweepPage ? null : page[^1];
            return page;
        }

        /// <summary>
        /// True when the part a request asks for is in Jellyfin for the person who asked ("Ready" for them), judged on a
        /// full read: fulfilled is final, so a season that reads Ready only because Sonarr couldn't be read (one episode
        /// here, the rest unknown) waits for the next look.
        /// </summary>
        private async Task<bool> ArrivedAsync(RequestWant want, CancellationToken cancellationToken)
        {
            if (TitleKey.Parse(want.Input.Key) is not { } key || _view.Viewer(want.UserId) is not { } viewer) return false;
            // F83: an ask still in TMDB's numbering has no Sonarr or library episode yet (its id match renumbers it once it
            // goes out): it is never fulfilled by an episode that merely has the same number.
            if (want.Input.Numbering == EpisodeIdentity.Tmdb)
            {
                // A request with no send of its own to switch it (one joining another's sent episode, or one whose job ended
                // since) takes the id matches already kept: its change is published, and it is judged as it is now.
                var changed = _ledger.SettleIdentity(want, _now());
                if (changed.Count == 0) return false;
                _feed.Bump(changed.Select(ArrTitleKey.UserRequests).Append(want.Input.Key).Append(ArrTitleKey.RequestsState).ToArray());
                if (_ledger.Find(want.Id) is not { } switched || switched.Input.Numbering == EpisodeIdentity.Tmdb) return false;
                want = switched;
            }
            var title = key.ToString();
            var scope = LedgerRequestFacts.ScopeOf(new[] { want }, want.UserId, () => _ledger.Dispatches(title));
            var composed = await _status.ComposeForAsync(viewer, new[] { key }, new Dictionary<TitleKey, ArrStatusService.RequestScope> { [key] = scope }, cancellationToken, loadEpisodes: true).ConfigureAwait(false);
            // The requester again, right before it is marked: someone removed, or whose access changed while the check
            // ran, is judged again next time (as they are then).
            return composed.Count > 0 && composed[0].Status.Stage == StatusStage.Ready && !composed[0].Guessed
                && _view.Viewer(want.UserId) is { } still && string.Equals(still.PolicyRevision, viewer.PolicyRevision, StringComparison.Ordinal);
        }
    }
}

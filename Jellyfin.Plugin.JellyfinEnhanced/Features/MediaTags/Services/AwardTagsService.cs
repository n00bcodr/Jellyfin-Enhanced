using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
{
    /// <summary>
    /// Shared, persisted Awards facts. Only the refresh task performs network work;
    /// poster reads are cache-only. Failed refreshes retain last good facts for the
    /// same configuration and retry after an hour. No credentials are persisted.
    /// </summary>
    public sealed class AwardTagsService
    {
        private readonly MdblistService _mdblist;
        private readonly WikidataAwardsService _wikidata;
        private readonly Logger _logger;
        private readonly string _path;
        private readonly SemaphoreSlim _refresh = new(1, 1);
        private readonly object _sync = new();
        private readonly Dictionary<string, CachedTitle> _titles = new(StringComparer.Ordinal);
        private readonly Dictionary<string, CachedList> _lists = new(StringComparer.Ordinal);

        public AwardTagsService(IHttpClientFactory http, IApplicationPaths paths, MdblistService mdblist, WikidataAwardsService wikidata, Logger logger)
        {
            _mdblist = mdblist;
            _wikidata = wikidata;
            _logger = logger;
            _path = Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "award-tags.json");
            try
            {
                if (!File.Exists(_path)) return;
                var disk = JsonSerializer.Deserialize<Disk>(File.ReadAllText(_path));
                if (disk?.Schema != 1) return;
                foreach (var pair in disk.Titles) if (pair.Value?.Facts != null) _titles[pair.Key] = pair.Value;
                foreach (var pair in disk.Lists) if (pair.Value?.Ranks is { Count: > 0 }) _lists[pair.Key] = pair.Value;
            }
            catch (Exception ex) { _logger.Warning($"[AwardTags] Could not read snapshot: {ex.Message}"); }
        }

        private static string Signature(PluginConfiguration config) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{config.MdblistApiKey}|{config.AwardsTagsImdbList}|{config.AwardsTagsLetterboxdList}|{config.AwardsTagsImdb}|{config.AwardsTagsLetterboxd}|{config.AwardsTagsCertifiedFresh}|{config.AwardsTagsOscar}|{config.AwardsTagsEmmy}")));

        /// <summary>Only Awards provider/gate changes need to republish facts on an admin save.</summary>
        internal static string ConfigurationIdentity(PluginConfiguration? config) => config == null ? "" : config.AwardsTagsEnabled + ":" + Signature(config);

        private static string Key(string type, string id, PluginConfiguration config) => Signature(config) + ":" + type + ":" + id;

        /// <summary>
        /// Whether any title has been fetched under the current configuration. False right after Awards is first turned
        /// on (or its providers change), until a refresh has run.
        /// </summary>
        /// <param name="config">The configuration.</param>
        /// <returns>True when at least one title has facts.</returns>
        public bool HasFacts(PluginConfiguration? config)
        {
            if (config == null) return false;
            var prefix = Signature(config) + ":";
            lock (_sync) return _titles.Keys.Any(key => key.StartsWith(prefix, StringComparison.Ordinal));
        }

        /// <summary>Cache-only facts, unavailable while the master is off or after provider configuration changes.</summary>
        public TagAwards? GetCached(string type, string id, PluginConfiguration? config)
        {
            if (config?.AwardsTagsEnabled != true) return null;
            lock (_sync) return _titles.TryGetValue(Key(type, id, config), out var entry) ? entry.Facts : null;
        }

        /// <summary>Refresh a deduplicated title set sequentially, checking cancellation and TTL before each lookup.</summary>
        public async Task RefreshAsync(IEnumerable<(string Type, string Id)> titles, PluginConfiguration config, IProgress<double>? progress, CancellationToken token)
        {
            if (!config.AwardsTagsEnabled) { progress?.Report(100); return; }
            await _refresh.WaitAsync(token).ConfigureAwait(false);
            try
            {
                var candidates = titles.Where(t => t.Type is "movie" or "tv" && t.Id.Length is > 0 and < 20 && t.Id.All(char.IsAsciiDigit)).Distinct().ToArray();
                var ttl = TimeSpan.FromHours(Math.Clamp(config.AwardsTagsRefreshHours, 1, 168));
                var hasKey = !string.IsNullOrWhiteSpace(config.MdblistApiKey);
                CachedList? imdb = null, letterboxd = null;
                if (hasKey && config.AwardsTagsImdb) imdb = await GetListAsync(config.AwardsTagsImdbList, config, ttl, token).ConfigureAwait(false);
                if (hasKey && config.AwardsTagsLetterboxd) letterboxd = await GetListAsync(config.AwardsTagsLetterboxdList, config, ttl, token).ConfigureAwait(false);
                if (hasKey && config.AwardsTagsCertifiedFresh)
                    await _mdblist.WarmTagRatingsAsync(candidates.Select(t => (t.Type, t.Id)), token, config.MdblistFetchReserve, maxAge: ttl).ConfigureAwait(false);
                var done = 0;
                foreach (var title in candidates)
                {
                    token.ThrowIfCancellationRequested();
                    var key = Key(title.Type, title.Id, config);
                    CachedTitle? old;
                    lock (_sync) _titles.TryGetValue(key, out old);
                    if (old?.NextRefresh > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) { progress?.Report(++done * 100d / candidates.Length); continue; }
                    var confirmed = true;
                    var facts = old?.Facts ?? new TagAwards();
                    if (hasKey)
                    {
                        if (config.AwardsTagsImdb) { confirmed &= imdb?.Confirmed == true; if (imdb != null) facts = facts with { ImdbRank = Rank(imdb, title) }; }
                        if (config.AwardsTagsLetterboxd) { confirmed &= letterboxd?.Confirmed == true; if (letterboxd != null) facts = facts with { LetterboxdRank = Rank(letterboxd, title) }; }
                        if (config.AwardsTagsCertifiedFresh)
                        {
                            var ratings = _mdblist.GetCachedEntry(title.Type, title.Id);
                            // A quota skip leaves the old confirmed entry intact; it is not proof of a fresh refresh.
                            confirmed &= ratings?.Confirmed == true
                                && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - ratings.FetchedAtUnixMs < ttl.TotalMilliseconds;
                            if (ratings?.Confirmed == true) facts = facts with { CertifiedFresh = ratings.Ratings.Any(r => r.Source == "tomatoes" && r.Certified == true) };
                        }
                    }
                    if (config.AwardsTagsOscar || config.AwardsTagsEmmy)
                    {
                        var awards = await _wikidata.GetAwardsAsync(title.Type, title.Id, token).ConfigureAwait(false);
                        token.ThrowIfCancellationRequested();
                        confirmed &= awards.Confirmed;
                        if (awards.Confirmed) facts = MergeWinners(facts, awards, config);
                    }
                    var expires = DateTimeOffset.UtcNow.Add(confirmed ? ttl : TimeSpan.FromHours(1)).ToUnixTimeMilliseconds();
                    lock (_sync) _titles[key] = new CachedTitle { Facts = facts, NextRefresh = expires };
                    progress?.Report(++done * 100d / candidates.Length);
                }
                progress?.Report(100);
            }
            finally
            {
                Save(); // Includes completed titles when a task is cancelled.
                _refresh.Release();
            }
        }

        private static int? Rank(CachedList list, (string Type, string Id) title) => list.Ranks.TryGetValue(title.Type + ":" + title.Id, out var rank) && rank is > 0 and <= 250 ? rank : null;

        /// <summary>Only wins for the exact work qualify; nominations and unrelated honors do not.</summary>
        internal static TagAwards MergeWinners(TagAwards facts, AwardsCacheEntry awards, PluginConfiguration config)
        {
            var won = awards.Awards.Where(a => a.Result == "Won").ToArray();
            var oscars = won.Where(a => a.Name.StartsWith("Academy Award", StringComparison.OrdinalIgnoreCase)).ToArray();
            var emmys = won.Where(a => a.Name.StartsWith("Primetime Emmy Award", StringComparison.OrdinalIgnoreCase) || a.Name.StartsWith("Daytime Emmy Award", StringComparison.OrdinalIgnoreCase) || a.Name.StartsWith("International Emmy Award", StringComparison.OrdinalIgnoreCase)).ToArray();
            return facts with
            {
                OscarWinner = config.AwardsTagsOscar && oscars.Length > 0,
                OscarYear = config.AwardsTagsOscar ? oscars.Select(a => a.Year).Max() : null,
                EmmyWinner = config.AwardsTagsEmmy && emmys.Length > 0,
                EmmyYear = config.AwardsTagsEmmy ? emmys.Select(a => a.Year).Max() : null,
            };
        }

        private async Task<CachedList?> GetListAsync(string id, PluginConfiguration config, TimeSpan ttl, CancellationToken token)
        {
            if (!AwardLists.IsListId(id)) return null;
            var key = Signature(config) + ":" + id;
            CachedList? old;
            lock (_sync) _lists.TryGetValue(key, out old);
            if (old?.NextRefresh > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) return old;
            try
            {
                var ranks = await _mdblist.GetAwardListWithinReserveAsync(id, config.MdblistFetchReserve, token).ConfigureAwait(false);
                if (ranks == null) throw new HttpRequestException("MDBList chart unavailable within quota reserve");
                var fresh = new CachedList { Ranks = ranks, Confirmed = true, NextRefresh = DateTimeOffset.UtcNow.Add(ttl).ToUnixTimeMilliseconds() };
                lock (_sync) _lists[key] = fresh;
                return fresh;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch (Exception)
            {
                // Do not log the request URI, which contains the server key.
                _logger.Warning("[AwardTags] MDBList chart refresh failed; retaining the previous snapshot and retrying in one hour.");
                var failed = new CachedList { Ranks = old?.Ranks ?? new(), Confirmed = false, NextRefresh = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds() };
                lock (_sync) _lists[key] = failed;
                return failed;
            }
        }

        private void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                lock (_sync)
                {
                    File.WriteAllText(_path + ".tmp", JsonSerializer.Serialize(new Disk { Titles = _titles, Lists = _lists }));
                    File.Move(_path + ".tmp", _path, overwrite: true);
                }
            }
            catch (Exception ex) { _logger.Warning($"[AwardTags] Could not save snapshot: {ex.Message}"); }
        }

        public sealed class CachedTitle { public TagAwards Facts { get; set; } = new(); public long NextRefresh { get; set; } }
        public sealed class CachedList { public Dictionary<string, int> Ranks { get; set; } = new(); public bool Confirmed { get; set; } public long NextRefresh { get; set; } }
        public sealed class Disk { public int Schema { get; set; } = 1; public Dictionary<string, CachedTitle> Titles { get; set; } = new(); public Dictionary<string, CachedList> Lists { get; set; } = new(); }
    }
}

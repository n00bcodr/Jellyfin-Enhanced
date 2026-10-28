using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// The automatic requests' lookup of a person's Seerr account (the legacy collection and next-season requests): one
    /// implementation for both, under the person's <see cref="SeerrAccountAuthority"/>. A held id is served only under the
    /// authority it was read under (the same Seerr, the same link generation) and within its lifetime from its read's start
    /// on the monotonic clock; a fresh read records what it found (a complete list without the person included), and one
    /// overtaken by a newer read of the person's account is read once more (else nobody). A send checks
    /// <see cref="IsCurrent"/> right before its POST.
    /// </summary>
    internal sealed class SeerrAccountLookup
    {
        private const int Take = 1000;

        // Seerr-derived facts: held in the effective backend's generation-owned cache (an adoption retires them).
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Cache<(string Id, long ReadAt, SeerrAccountAuthority.Ticket Authority)> _ids = new();
        private readonly string _prefix;

        /// <summary>Creates the lookup.</summary>
        /// <param name="prefix">The log prefix of the service using it.</param>
        public SeerrAccountLookup(string prefix)
        {
            _prefix = prefix;
        }

        private static TimeSpan Lifetime()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrUserIdCacheTtlMinutes ?? 30;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        private static string Person(string jellyfinUserId) => SeerrAccountAuthority.PersonOf(jellyfinUserId);

        /// <summary>Whether an account read under <paramref name="authority"/> may still be sent as, for the Seerr configured now.</summary>
        /// <param name="authority">The authority the id came with.</param>
        /// <returns>True when still the person's.</returns>
        public static bool IsCurrent(in SeerrAccountAuthority.Ticket authority)
            => SeerrAccountAuthority.IsCurrent(authority, JellyfinEnhanced.Instance?.Configuration);

        /// <summary>
        /// The person's Seerr account id at the Seerr configured now and the authority it holds under (null id: none is
        /// known — not linked, or Seerr didn't answer).
        /// </summary>
        /// <param name="http">The HTTP client factory.</param>
        /// <param name="logger">The service's logger.</param>
        /// <param name="jellyfinUserId">The person.</param>
        /// <returns>The id and its authority.</returns>
        public async Task<(string? Id, SeerrAccountAuthority.Ticket Authority)> ReadAsync(IHttpClientFactory http, Logger logger, string jellyfinUserId)
        {
            var (id, authority, superseded) = await ReadOnceAsync(http, logger, jellyfinUserId).ConfigureAwait(false);
            if (!superseded) return (id, authority);
            (id, authority, superseded) = await ReadOnceAsync(http, logger, jellyfinUserId).ConfigureAwait(false);
            return superseded ? (null, authority) : (id, authority);
        }

        private async Task<(string? Id, SeerrAccountAuthority.Ticket Authority, bool Superseded)> ReadOnceAsync(IHttpClientFactory http, Logger logger, string jellyfinUserId)
        {
            // Taken before anything is read: the read's instant starts the id's lifetime, the authority ends it.
            var readAt = MonotonicClock.Now();
            var config = JellyfinEnhanced.Instance?.Configuration;
            var person = Person(jellyfinUserId);
            var authority = SeerrAccountAuthority.Capture(SeerrAccountAuthority.SourceOf(config), person);
            // Seerr excluded by the effective backend (switched off, or isolated): nothing is read from it or served from memory.
            if (!Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends.EffectiveRequestsBackend.AllowsSeerr(config)
                || config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                return (null, authority, false);
            }

            using (Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.CacheMutation())
            {
                if (_ids.TryGetValue(person, out var held))
                {
                    if (held.Authority == authority && MonotonicClock.Now() - held.ReadAt < Lifetime().Ticks) return (held.Id, authority, false);
                    _ids.Remove(person);
                }
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(url => url.Trim().TrimEnd('/'))
                .Where(url => url.Length > 0)
                .ToArray();
            var client = SeerrHttpHelper.CreateClient(http);
            var listedWithout = false;
            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url}/api/v1/user?take={Take}";
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.GetJellyseerrApiKey());
                    using var response = await client.SendAsync(request).ConfigureAwait(false);
                    var (content, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri).ConfigureAwait(false);
                    if (error != null || content == null)
                    {
                        if (error != null) logger.Warning($"{_prefix} Failed to fetch users from Jellyseerr: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                        continue;
                    }

                    var usersResponse = JsonSerializer.Deserialize<JsonElement>(content);
                    if (!usersResponse.TryGetProperty("results", out var usersArray) || usersArray.ValueKind != JsonValueKind.Array) continue;
                    var count = 0;
                    foreach (var userElement in usersArray.EnumerateArray())
                    {
                        count++;
                        if (userElement.TryGetProperty("jellyfinUserId", out var jfUserId) && userElement.TryGetProperty("id", out var idElement)
                            && jfUserId.GetString() is { Length: > 0 } linked && Person(linked) == person && idElement.TryGetInt32(out var account))
                        {
                            if (!SeerrAccountAuthority.Admit(ref authority, account)) return (null, authority, true);
                            var id = account.ToString(System.Globalization.CultureInfo.InvariantCulture);
                            using (Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.CacheMutation())
                            {
                                if (IsCurrent(authority)) _ids[person] = (id, readAt, authority);
                            }

                            return (id, authority, false);
                        }
                    }

                    var total = usersResponse.TryGetProperty("pageInfo", out var info) && info.ValueKind == JsonValueKind.Object
                        && info.TryGetProperty("results", out var all) && all.TryGetInt32(out var n) ? n : (int?)null;
                    if (count < Take || total is int t && t <= count) listedWithout = true;
                    logger.Warning($"{_prefix} No Jellyseerr user found for Jellyfin user {jellyfinUserId}");
                }
                catch (Exception ex)
                {
                    logger.Error($"{_prefix} Exception while trying to get Jellyseerr user ID from {url}: {ex.Message}");
                }
            }

            // Seerr listed its accounts completely and links none to the person: an observation too.
            if (listedWithout && !SeerrAccountAuthority.Admit(ref authority, null)) return (null, authority, true);
            return (null, authority, false);
        }
    }
}

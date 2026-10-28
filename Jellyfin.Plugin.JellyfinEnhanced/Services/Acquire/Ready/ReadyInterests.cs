using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>A person's own interests the Ready playlist is built from.</summary>
    public interface IReadyInterestSource
    {
        /// <summary>
        /// The person's own interests, or null when they can't be read reliably now (the database is unavailable, or the
        /// request authority hasn't been read completely): nothing is added or removed until they can.
        /// </summary>
        /// <param name="user">The person.</param>
        /// <returns>Interests, or null.</returns>
        IReadOnlyList<ReadyInterest>? For(Guid user);

        /// <summary>The people with an interest in a title known by any of these keys (an arrival marks them for a look).</summary>
        /// <param name="keys">The title's keys.</param>
        /// <returns>People.</returns>
        IReadOnlyCollection<Guid> Interested(IReadOnlyList<TitleKey> keys);
    }

    /// <summary>
    /// <see cref="IReadyInterestSource"/> over the request authority and explicit follows. Requests come from the authority
    /// requests are handled by (Jellyfin Enhanced's ledger, which list and import wants are part of, or Seerr's requests
    /// linked to the person), never a union of both and never anyone else's. A request that arrived stays an interest
    /// (fulfilment can beat the Ready worker); a cancelled or declined one is none. An explicit follow (Notify me) is an
    /// interest in any copy, a known standard one first; a title the person muted is no follow interest (their requests
    /// stay theirs). Lists themselves are never interests: an entry on someone's list is no consent to a playlist.
    /// </summary>
    public sealed class ReadyInterestSource : IReadyInterestSource
    {
        private readonly RequestLedger _ledger;
        private readonly SeerrFacts _seerr;
        private readonly NotifyStore _follows;
        private readonly TitleAliases? _aliases;
        private readonly Func<PluginConfiguration?> _config;

        /// <summary>Creates the source (DI).</summary>
        public ReadyInterestSource(RequestLedger ledger, SeerrFacts seerr, NotifyStore follows, TitleAliases aliases)
            : this(ledger, seerr, follows, aliases, null)
        {
        }

        /// <summary>Creates the source with an explicit configuration (tests).</summary>
        internal ReadyInterestSource(RequestLedger ledger, SeerrFacts seerr, NotifyStore follows, TitleAliases? aliases, Func<PluginConfiguration?>? config)
        {
            _ledger = ledger;
            _seerr = seerr;
            _follows = follows;
            _aliases = aliases;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
        }

        /// <inheritdoc />
        public IReadOnlyList<ReadyInterest>? For(Guid user)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Compose(() => ForFactsCore(user));

        private IReadOnlyList<ReadyInterest>? ForFactsCore(Guid user)
        {
            var config = _config();
            var list = new List<ReadyInterest>();
            if (!_follows.Available) return null;
            var follows = _follows.Follows(user);
            var muted = new HashSet<string>(follows.Where(f => f.Muted && TitleKey.Parse(f.Key)?.Season == null).Select(f => TitleKey.Parse(f.Key)!.Title.ToString()), StringComparer.Ordinal);
            foreach (var f in follows.Where(f => !f.Muted))
            {
                if (TitleKey.Parse(f.Key) is not { } key || muted.Contains(key.Title.ToString())) continue;
                var whole = key.Season == null;
                list.Add(new ReadyInterest("f:" + f.Key, user, ReadyInterestKind.Follow, key.Title, false, true, whole,
                    key.Season is int s ? new[] { s } : Array.Empty<int>(), Array.Empty<(int, int)>(), f.CreatedAt.UtcDateTime));
            }

            if (SharedRequestFacts.LedgerAuthority(config))
            {
                if (!_ledger.Database.Available) return null;
                foreach (var want in _ledger.List(user, false))
                {
                    if (want.UserId != user || want.Status is "cancelled" or "declined") continue;
                    if (TitleKey.Parse(want.Input.Key) is not { } key) continue;
                    var input = want.Input;
                    var whole = input.Scope is "movie" or "future";
                    list.Add(new ReadyInterest("w:" + want.Id, user, ReadyInterestKind.Request, key.Title, input.Variant == "4k", false, whole,
                        input.Scope is "seasons" or "next_season" ? input.Seasons : Array.Empty<int>(),
                        input.Scope == "episodes" ? input.Episodes.Select(e => (e.Season, e.Episode)).ToArray() : Array.Empty<(int, int)>(),
                        want.CreatedAt.UtcDateTime));
                }
            }
            else if (SharedRequestFacts.Active(config) && config!.ArrRequestBackend == "seerr")
            {
                // Seerr is the authority: only a complete read of it (a partial one could drop someone's requests).
                if (!_seerr.Active || !_seerr.Loaded || _seerr.State.IncompleteReason != null || _seerr.State.LastError != null) return null;
                foreach (var record in _seerr.ForUser(user))
                {
                    if (record.RequestedBy != user || !record.Active || record.Key is not { } key || record.CreatedAt is not DateTime created) continue;
                    var at = created.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(created, DateTimeKind.Utc) : created.ToUniversalTime();
                    var whole = record.IsMovie || record.Seasons.Count == 0;
                    list.Add(new ReadyInterest("s:" + record.Id.ToString(System.Globalization.CultureInfo.InvariantCulture) + (record.Is4k ? ":4k" : string.Empty), user, ReadyInterestKind.Seerr,
                        key.Title, record.Is4k, false, whole, record.IsMovie ? Array.Empty<int>() : record.Seasons, Array.Empty<(int, int)>(), at));
                }
            }

            return list;
        }

        /// <inheritdoc />
        public IReadOnlyCollection<Guid> Interested(IReadOnlyList<TitleKey> keys)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Compose(() => InterestedFactsCore(keys));

        private IReadOnlyCollection<Guid> InterestedFactsCore(IReadOnlyList<TitleKey> keys)
        {
            var titles = new HashSet<string>(StringComparer.Ordinal);
            foreach (var key in keys)
            {
                titles.Add(key.Title.ToString());
                foreach (var alias in _aliases?.Of(key) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>()) titles.Add(alias.Title.ToString());
            }

            var users = new HashSet<Guid>();
            if (titles.Count == 0) return users;
            if (_follows.Available)
            {
                foreach (var f in _follows.FollowsOfTitles(titles)) users.Add(f.UserId);
            }

            if (_ledger.Database.Available)
            {
                foreach (var title in titles)
                {
                    foreach (var want in _ledger.ForTitle(title)) users.Add(want.UserId);
                }
            }

            foreach (var title in titles)
            {
                if (TitleKey.Parse(title) is not { } key) continue;
                foreach (var record in _seerr.ForTitle(key))
                {
                    if (record.RequestedBy is Guid u) users.Add(u);
                }
            }

            return users;
        }
    }
}

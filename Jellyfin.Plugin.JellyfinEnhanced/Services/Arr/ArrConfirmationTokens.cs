using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Server-issued confirmation tokens for destructive (Tier 3) arr actions such as "remove with
    /// data". A token is bound to one user, action, instance and target, expires after two minutes
    /// and works once. The client gets the token from a "confirm" step that shows what will happen,
    /// then sends it with the action. Only a hash of each token is kept, in memory (a restart
    /// invalidates outstanding tokens, which is the safe direction).
    /// </summary>
    public sealed class ArrConfirmationTokens
    {
        private const int MaxOutstandingPerUser = 20;
        private readonly TimeSpan _ttl;
        private readonly Func<DateTimeOffset> _now;
        private readonly object _lock = new();
        private readonly Dictionary<string, Pending> _pending = new(StringComparer.Ordinal);

        private sealed record Pending(Guid UserId, string Binding, DateTimeOffset Expires, DateTimeOffset Issued);

        /// <summary>Tokens valid for two minutes.</summary>
        public ArrConfirmationTokens()
            : this(TimeSpan.FromMinutes(2), null)
        {
        }

        /// <summary>Tokens with an explicit lifetime and clock (tests).</summary>
        internal ArrConfirmationTokens(TimeSpan ttl, Func<DateTimeOffset>? now)
        {
            _ttl = ttl;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>Issues a token for one exact action.</summary>
        /// <returns>The token and when it expires.</returns>
        public (string Token, DateTimeOffset ExpiresAt) Issue(Guid userId, string action, string instanceId, string target)
        {
            var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            var now = _now();
            var expires = now + _ttl;
            lock (_lock)
            {
                Prune(now);
                var mine = _pending.Where(p => p.Value.UserId == userId).OrderBy(p => p.Value.Issued).ToList();
                foreach (var old in mine.Take(Math.Max(0, mine.Count - MaxOutstandingPerUser + 1)))
                {
                    _pending.Remove(old.Key);
                }
                _pending[Hash(token)] = new Pending(userId, Binding(action, instanceId, target), expires, now);
            }
            return (token, expires);
        }

        /// <summary>
        /// Checks and consumes a token. Fails (and still consumes a token that exists) when it was
        /// issued to another user or for another action, instance or target.
        /// </summary>
        public bool TryConsume(string? token, Guid userId, string action, string instanceId, string target, out string reason)
        {
            if (string.IsNullOrWhiteSpace(token))
            {
                reason = "confirmation_required";
                return false;
            }
            lock (_lock)
            {
                var now = _now();
                Prune(now);
                var key = Hash(token);
                if (!_pending.Remove(key, out var pending))
                {
                    reason = "confirmation_invalid_or_expired";
                    return false;
                }
                if (pending.UserId != userId || !CryptographicOperations.FixedTimeEquals(
                        Encoding.UTF8.GetBytes(pending.Binding), Encoding.UTF8.GetBytes(Binding(action, instanceId, target))))
                {
                    reason = "confirmation_mismatch";
                    return false;
                }
                reason = string.Empty;
                return true;
            }
        }

        private void Prune(DateTimeOffset now)
        {
            foreach (var expired in _pending.Where(p => p.Value.Expires <= now).Select(p => p.Key).ToList())
            {
                _pending.Remove(expired);
            }
        }

        private static string Binding(string action, string instanceId, string target)
            => action + "\n" + (instanceId ?? string.Empty).ToLowerInvariant() + "\n" + target;

        private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// One shared request pool: its stable id, name, request limit per household window, and who is in it (roles,
    /// <c>*</c> for everyone, and named people). Pools are listed in precedence order.
    /// </summary>
    public sealed record GroupQuotaPool
    {
        /// <summary>Stable id (letters, digits, dash, underscore); reservations are bound to it.</summary>
        [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

        /// <summary>Display name (administrators and members see it).</summary>
        [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;

        /// <summary>Requests the pool allows per rolling household window (1..10000).</summary>
        [JsonPropertyName("limit")] public int Limit { get; init; }

        /// <summary>Roles in the pool (Kid, Member, Trusted, Manager, or <c>*</c> for everyone).</summary>
        [JsonPropertyName("roles")] public string[] Roles { get; init; } = Array.Empty<string>();

        /// <summary>People in the pool (Jellyfin user ids, N format), whatever their role.</summary>
        [JsonPropertyName("users")] public string[] Users { get; init; } = Array.Empty<string>();
    }

    /// <summary>The pool a person's requests draw on now: id, name, limit and the household window (days).</summary>
    /// <param name="Id">Pool id.</param>
    /// <param name="Name">Pool name.</param>
    /// <param name="Limit">Request limit per window.</param>
    /// <param name="WindowDays">Rolling window in days.</param>
    public sealed record GroupPoolBinding(string Id, string Name, int Limit, int WindowDays);

    /// <summary>
    /// Group quotas (phase 4b, F24): shared pools for the household or for roles, on top of each person's own limit and
    /// the hard GB cap. A person draws on the first pool naming them, else the first pool naming their role (or <c>*</c>);
    /// administrators never do. A reservation is bound to its pool when it is made and stays there (a later role or pool
    /// change never moves spend). Going over a pool is soft: the request waits for an OK, and an approval may grant it.
    /// </summary>
    public static class GroupQuotaPolicy
    {
        /// <summary>Most pools.</summary>
        public const int MaxPools = 20;

        /// <summary>Roles a pool may name.</summary>
        public static readonly IReadOnlyList<string> PoolRoles = new[] { "*", "Kid", "Member", "Trusted", "Manager" };

        private static readonly Regex IdPattern = new("^[A-Za-z0-9_-]{1,40}$", RegexOptions.CultureInvariant);
        private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };
        private static Parsed _parsed = new(null, Array.Empty<GroupQuotaPool>());

        private sealed record Parsed(string? Json, IReadOnlyList<GroupQuotaPool> Pools);

        /// <summary>The stored pools (empty when unset or unreadable), parsed once per stored value.</summary>
        /// <param name="json">Stored JSON array.</param>
        public static IReadOnlyList<GroupQuotaPool> Parse(string? json)
        {
            var held = Volatile.Read(ref _parsed);
            if (string.Equals(held.Json, json, StringComparison.Ordinal)) return held.Pools;
            IReadOnlyList<GroupQuotaPool> pools;
            try
            {
                var list = string.IsNullOrWhiteSpace(json) ? new List<GroupQuotaPool>() : JsonSerializer.Deserialize<List<GroupQuotaPool>>(json, Options) ?? new List<GroupQuotaPool>();
                pools = Validate(list) == null ? list : Array.Empty<GroupQuotaPool>();
            }
            catch (JsonException)
            {
                pools = Array.Empty<GroupQuotaPool>();
            }

            Volatile.Write(ref _parsed, new Parsed(json, pools));
            return pools;
        }

        /// <summary>Why a pool list can't be saved (an error code), or null when it is valid.</summary>
        /// <param name="pools">The pools.</param>
        public static string? Validate(IReadOnlyList<GroupQuotaPool>? pools)
        {
            if (pools == null || pools.Count > MaxPools) return "invalid_pools";
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pool in pools)
            {
                if (pool == null || !IdPattern.IsMatch(pool.Id ?? string.Empty) || !ids.Add(pool.Id!)) return "invalid_pool_id";
                if (string.IsNullOrWhiteSpace(pool.Name) || pool.Name.Length > 60 || pool.Name.Any(char.IsControl)) return "invalid_pool_name";
                if (pool.Limit is < 1 or > 10000) return "invalid_pool_limit";
                if (pool.Roles == null || pool.Users == null || pool.Roles.Length > PoolRoles.Count || pool.Users.Length > 500) return "invalid_pool_members";
                if (pool.Roles.Any(r => !PoolRoles.Contains(r, StringComparer.OrdinalIgnoreCase))) return "invalid_pool_role";
                if (pool.Users.Any(u => !Guid.TryParse(u, out var id) || id == Guid.Empty)) return "invalid_user";
                if (pool.Roles.Length == 0 && pool.Users.Length == 0) return "invalid_pool_members";
            }

            return null;
        }

        /// <summary>Normalises a valid list for storage (canonical role names, user ids in N format, distinct).</summary>
        /// <param name="pools">A valid list.</param>
        public static string Store(IReadOnlyList<GroupQuotaPool> pools)
            => JsonSerializer.Serialize(pools.Select(p => p with
            {
                Name = p.Name.Trim(),
                Roles = p.Roles.Select(r => PoolRoles.First(x => string.Equals(x, r, StringComparison.OrdinalIgnoreCase))).Distinct(StringComparer.Ordinal).ToArray(),
                Users = p.Users.Select(u => Guid.Parse(u).ToString("N")).Distinct(StringComparer.Ordinal).ToArray(),
            }).ToList());

        /// <summary>
        /// The pool a person draws on now (null: none). The first pool naming the person wins; else the first naming
        /// their role or everyone. Administrators and Watchers are never pooled.
        /// </summary>
        /// <param name="pools">Pools in precedence order.</param>
        /// <param name="user">The person.</param>
        /// <param name="role">Their household role.</param>
        /// <param name="windowDays">The household window.</param>
        public static GroupPoolBinding? For(IReadOnlyList<GroupQuotaPool> pools, Guid user, string role, int windowDays)
        {
            if (role is "Admin" or "Watcher" || pools.Count == 0) return null;
            var pool = pools.FirstOrDefault(p => p.Users.Any(u => Guid.TryParse(u, out var g) && g == user))
                ?? pools.FirstOrDefault(p => p.Roles.Any(r => r == "*" || string.Equals(r, role, StringComparison.OrdinalIgnoreCase)));
            return pool == null ? null : new GroupPoolBinding(pool.Id, pool.Name, pool.Limit, Math.Clamp(windowDays, 1, 365));
        }

        /// <summary>The current definition of a pool by id (null: removed since).</summary>
        /// <param name="pools">Pools.</param>
        /// <param name="id">Pool id.</param>
        /// <param name="windowDays">The household window.</param>
        public static GroupPoolBinding? ById(IReadOnlyList<GroupQuotaPool> pools, string? id, int windowDays)
            => id == null ? null : pools.FirstOrDefault(p => string.Equals(p.Id, id, StringComparison.Ordinal)) is { } pool ? new GroupPoolBinding(pool.Id, pool.Name, pool.Limit, Math.Clamp(windowDays, 1, 365)) : null;
    }
}

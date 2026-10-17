using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps
{
    /// <summary>One stamp fact.</summary>
    /// <param name="ItemId">The movie or episode it is about.</param>
    /// <param name="UserId">The person (<see cref="Guid.Empty"/>: everyone who can open the item).</param>
    /// <param name="Kind"><see cref="AcquisitionStampKinds"/>.</param>
    /// <param name="At">When it arrived or was upgraded (UTC).</param>
    /// <param name="SeriesId">Episodes: the series item.</param>
    /// <param name="SeasonId">Episodes: the season item.</param>
    public sealed record StampFact(Guid ItemId, Guid UserId, string Kind, DateTime At, Guid? SeriesId, Guid? SeasonId);

    /// <summary>
    /// The durable stamp facts (acquire.db step 7): a person's own first arrivals ("new") and confirmed replacements
    /// ("upgraded", for everyone), each for one movie or episode. Expiry and "watched" are never stored: the resolver
    /// decides them at read time, so a stamp ends without any timer. Facts older than the longest lifetime are purged.
    /// Reads come from an in-memory index (by item, and by an episode's season and series, so their cards can show what
    /// arrived inside them); it is rebuilt from the database after a restore (the database's generation moved).
    /// Also keeps which arrivals were already judged and the first arrival of each movie edition and episode number, so a
    /// renamed upgrade (a new item id) is never taken for a first arrival.
    /// </summary>
    public sealed class AcquisitionStampStore
    {
        private static readonly TimeSpan Keep = TimeSpan.FromDays(AcquisitionStampFlags.MaxDays);

        private readonly AcquireDatabase _db;
        private readonly Func<DateTimeOffset> _now;
        private readonly object _gate = new();
        private volatile Index? _index;
        private long _revision;

        /// <summary>Creates the store (DI).</summary>
        /// <param name="db">The acquire database.</param>
        public AcquisitionStampStore(AcquireDatabase db)
            : this(db, () => DateTimeOffset.UtcNow)
        {
        }

        /// <summary>Creates the store with a clock (tests).</summary>
        /// <param name="db">The acquire database.</param>
        /// <param name="now">Clock.</param>
        internal AcquisitionStampStore(AcquireDatabase db, Func<DateTimeOffset> now)
        {
            _db = db;
            _now = now;
        }

        private sealed class Index
        {
            public Index(long generation, Dictionary<Guid, List<StampFact>> facts)
            {
                Generation = generation;
                Facts = facts;
            }

            public long Generation { get; }

            public Dictionary<Guid, List<StampFact>> Facts { get; }
        }

        /// <summary>True when the database can be used.</summary>
        public bool Available => _db.Available;

        /// <summary>Moves on with every change (and every reload), for caches built on the facts.</summary>
        public long Revision => Interlocked.Read(ref _revision);

        /// <summary>
        /// The facts about an item: its own (movie, episode) or, for a season or series id, those of the episodes in it.
        /// Empty when the database is unavailable. No I/O once loaded.
        /// </summary>
        /// <param name="id">Item id.</param>
        /// <returns>Facts.</returns>
        public IReadOnlyList<StampFact> FactsFor(Guid id)
        {
            var index = Current();
            if (index == null) return Array.Empty<StampFact>();
            return index.Facts.TryGetValue(id, out var list) ? list : Array.Empty<StampFact>();
        }

        /// <summary>True when there is at least one fact (cheap; lets callers skip work).</summary>
        public bool Any => Current() is { } index && index.Facts.Count > 0;

        /// <summary>Records a person's first arrival (kept once per item and person).</summary>
        /// <param name="user">The person.</param>
        /// <param name="item">The movie or episode.</param>
        /// <param name="at">When it arrived.</param>
        /// <param name="source">What the interest was (request, seerr, follow).</param>
        /// <returns>True when it was new.</returns>
        public bool AddNew(Guid user, StampItem item, DateTime at, string source)
            => Add(item, user, AcquisitionStampKinds.New, at, source, replace: false);

        /// <summary>
        /// Records a confirmed replacement (everyone who can open the item; a later upgrade of the same item moves its
        /// time). The item's "new" facts go: it is a replacement, not a first arrival.
        /// </summary>
        /// <param name="item">The movie or episode.</param>
        /// <param name="at">When the arr imported the replacement.</param>
        /// <param name="source">The import ("instance:historyId").</param>
        /// <returns>True when it changed anything.</returns>
        public bool AddUpgraded(StampItem item, DateTime at, string source)
            => Add(item, Guid.Empty, AcquisitionStampKinds.Upgraded, at, source, replace: true);

        /// <summary>Whether an item's arrival was already judged.</summary>
        /// <param name="itemId">Item.</param>
        /// <returns>True when judged.</returns>
        public bool Seen(Guid itemId) => _db.Available && _db.Read(c => Scalar(c, null, "SELECT 1 FROM acquisition_seen WHERE item_id=$i", ("$i", N(itemId))) != null);

        /// <summary>Marks an item's arrival as judged.</summary>
        /// <param name="itemId">Item.</param>
        public void MarkSeen(Guid itemId)
        {
            if (!_db.Available) return;
            _db.Write((c, t) => Exec(c, t, "INSERT OR IGNORE INTO acquisition_seen(item_id,seen_at) VALUES($i,$at)", ("$i", N(itemId)), ("$at", Ms(_now().UtcDateTime))));
        }

        /// <summary>The earliest recorded arrival of any of these parts, or null.</summary>
        /// <param name="parts">Part keys (<see cref="PartKeys"/>).</param>
        /// <returns>First arrival (UTC).</returns>
        public DateTime? FirstArrival(IEnumerable<string> parts)
        {
            if (!_db.Available) return null;
            var list = parts.Distinct(StringComparer.Ordinal).ToList();
            if (list.Count == 0) return null;
            return _db.Read(c =>
            {
                DateTime? first = null;
                foreach (var part in list)
                {
                    if (Scalar(c, null, "SELECT first_at FROM acquisition_arrivals WHERE part_key=$p", ("$p", part)) is long ms)
                    {
                        var at = FromMs(ms);
                        if (first == null || at < first) first = at;
                    }
                }

                return first;
            });
        }

        /// <summary>Records that these parts arrived at <paramref name="at"/> (an earlier recorded time wins).</summary>
        /// <param name="parts">Part keys.</param>
        /// <param name="at">Arrival (UTC).</param>
        /// <param name="itemId">The item that brought it.</param>
        public void NoteArrival(IEnumerable<string> parts, DateTime at, Guid itemId)
        {
            if (!_db.Available) return;
            var list = parts.Distinct(StringComparer.Ordinal).ToList();
            if (list.Count == 0) return;
            _db.Write((c, t) =>
            {
                foreach (var part in list)
                {
                    Exec(c, t, "INSERT INTO acquisition_arrivals(part_key,first_at,item_id) VALUES($p,$at,$i) ON CONFLICT(part_key) DO UPDATE SET first_at=excluded.first_at,item_id=excluded.item_id WHERE excluded.first_at<acquisition_arrivals.first_at",
                        ("$p", part), ("$at", Ms(at)), ("$i", N(itemId)));
                }

                return 0;
            });
        }

        /// <summary>Removes everything kept for a person (they were deleted).</summary>
        /// <param name="user">The person.</param>
        public void PurgeUser(Guid user)
        {
            if (!_db.Available || user == Guid.Empty) return;
            _db.Write((c, t) => Exec(c, t, "DELETE FROM acquisition_stamps WHERE user_id=$u", ("$u", N(user))));
            Reload();
        }

        /// <summary>Removes facts and records older than the longest lifetime.</summary>
        /// <returns>Rows removed.</returns>
        public int Purge()
        {
            if (!_db.Available) return 0;
            var cutoff = Ms(_now().UtcDateTime - Keep);
            var removed = _db.Write((c, t) =>
                Exec(c, t, "DELETE FROM acquisition_stamps WHERE at<$c", ("$c", cutoff))
                + Exec(c, t, "DELETE FROM acquisition_seen WHERE seen_at<$c", ("$c", cutoff))
                + Exec(c, t, "DELETE FROM acquisition_arrivals WHERE first_at<$c", ("$c", cutoff)));
            if (removed > 0) Reload();
            return removed;
        }

        /// <summary>
        /// The keys under which an arrival is remembered: each movie key with its edition, or each series key with the
        /// episode numbers and edition.
        /// </summary>
        /// <param name="item">A movie or an episode.</param>
        /// <returns>Part keys.</returns>
        public static IReadOnlyList<string> PartKeys(StampItem item)
        {
            var edition = item.FourK ? "4k" : "std";
            var parts = new List<string>();
            foreach (var key in item.Keys)
            {
                if (item.Kind == "movie")
                {
                    parts.Add("m|" + key + "|" + edition);
                }
                else if (item.Season is int s && item.Episode is int e)
                {
                    var last = item.EpisodeEnd is int end && end >= e ? end : e;
                    for (var n = e; n <= last && n < e + 50; n++)
                    {
                        parts.Add("e|" + key + "|s" + s.ToString(CultureInfo.InvariantCulture) + "e" + n.ToString(CultureInfo.InvariantCulture) + "|" + edition);
                    }
                }
            }

            return parts;
        }

        /// <summary>Drops the in-memory index; the next read loads it again.</summary>
        public void Reload()
        {
            lock (_gate) _index = null;
            Interlocked.Increment(ref _revision);
        }

        private bool Add(StampItem item, Guid user, string kind, DateTime at, string source, bool replace)
        {
            if (!_db.Available || item.Id == Guid.Empty) return false;
            var created = Ms(_now().UtcDateTime);
            var changed = _db.Write((c, t) =>
            {
                var sql = replace
                    ? "INSERT INTO acquisition_stamps(item_id,user_id,kind,title_key,series_id,season_id,at,source,created_at) VALUES($i,$u,$k,$t,$se,$sn,$at,$src,$c) ON CONFLICT(item_id,user_id,kind) DO UPDATE SET at=excluded.at,source=excluded.source WHERE excluded.at>acquisition_stamps.at"
                    : "INSERT OR IGNORE INTO acquisition_stamps(item_id,user_id,kind,title_key,series_id,season_id,at,source,created_at) VALUES($i,$u,$k,$t,$se,$sn,$at,$src,$c)";
                var n = Exec(c, t, sql,
                    ("$i", N(item.Id)), ("$u", user == Guid.Empty ? string.Empty : N(user)), ("$k", kind), ("$t", item.Keys.FirstOrDefault()?.ToString()),
                    ("$se", item.SeriesId is Guid se ? N(se) : null), ("$sn", item.SeasonId is Guid sn ? N(sn) : null),
                    ("$at", Ms(at)), ("$src", source), ("$c", created));
                if (kind == AcquisitionStampKinds.Upgraded)
                {
                    n += Exec(c, t, "DELETE FROM acquisition_stamps WHERE item_id=$i AND kind='new'", ("$i", N(item.Id)));
                }

                return n;
            });
            if (changed > 0) Reload();
            return changed > 0;
        }

        private Index? Current()
        {
            if (!_db.Available) return null;
            var index = _index;
            var generation = _db.Generation;
            if (index != null && index.Generation == generation) return index;
            lock (_gate)
            {
                index = _index;
                if (index != null && index.Generation == generation) return index;
                index = Load(generation);
                _index = index;
                Interlocked.Increment(ref _revision);
                return index;
            }
        }

        private Index Load(long generation)
        {
            var cutoff = Ms(_now().UtcDateTime - Keep);
            var facts = _db.Read(c =>
            {
                var list = new List<StampFact>();
                using var cmd = c.CreateCommand();
                cmd.CommandText = "SELECT item_id,user_id,kind,at,series_id,season_id FROM acquisition_stamps WHERE at>=$c";
                cmd.Parameters.AddWithValue("$c", cutoff);
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    if (!Guid.TryParse(r.GetString(0), out var item)) continue;
                    var user = r.GetString(1);
                    list.Add(new StampFact(
                        item,
                        string.IsNullOrEmpty(user) || !Guid.TryParse(user, out var u) ? Guid.Empty : u,
                        r.GetString(2),
                        FromMs(r.GetInt64(3)),
                        r.IsDBNull(4) || !Guid.TryParse(r.GetString(4), out var se) ? null : se,
                        r.IsDBNull(5) || !Guid.TryParse(r.GetString(5), out var sn) ? null : sn));
                }

                return list;
            });
            var byId = new Dictionary<Guid, List<StampFact>>();
            void Put(Guid id, StampFact fact)
            {
                if (!byId.TryGetValue(id, out var list)) byId[id] = list = new List<StampFact>();
                list.Add(fact);
            }

            foreach (var fact in facts)
            {
                Put(fact.ItemId, fact);
                if (fact.SeasonId is Guid season && season != Guid.Empty) Put(season, fact);
                if (fact.SeriesId is Guid series && series != Guid.Empty) Put(series, fact);
            }

            return new Index(generation, byId);
        }

        private static string N(Guid id) => id.ToString("N", CultureInfo.InvariantCulture);

        private static long Ms(DateTime at) => new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

        private static DateTime FromMs(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime;

        private static int Exec(SqliteConnection c, SqliteTransaction? t, string sql, params (string Name, object? Value)[] args)
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = sql;
            foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
            return cmd.ExecuteNonQuery();
        }

        private static object? Scalar(SqliteConnection c, SqliteTransaction? t, string sql, params (string Name, object? Value)[] args)
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = sql;
            foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
            var result = cmd.ExecuteScalar();
            return result is DBNull ? null : result;
        }
    }
}

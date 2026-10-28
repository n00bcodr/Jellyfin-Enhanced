using System;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>A fixed server stage of an absent-title read. Names only: never a title, key, user or grant.</summary>
    internal enum Stage
    {
        /// <summary>The title's viewer policy (<c>NativeDetailsPolicy.SeeAsync</c>), parental evidence included.</summary>
        Policy,
        /// <summary>The policy's library visibility and physical-copy checks.</summary>
        Library,
        /// <summary>A restricted viewer's absent-title parental evidence (its own eight-second bound).</summary>
        Evidence,
        /// <summary>Discover/search parental checks under the two-second evidence budget.</summary>
        DiscoverEvidence,
        /// <summary>The library's own copies of a title (title actions).</summary>
        Copies,
        /// <summary>A public title or season feed (policy, source read and projection).</summary>
        Feed,
        /// <summary>A mapped native source answer already held (count only).</summary>
        SourceHit,
        /// <summary>Mapping a raw TMDB answer into the native source shape.</summary>
        SourceMap,
        /// <summary>Waiting for a feed budget token after a busy answer.</summary>
        SourceBusy,
        /// <summary>A metadata admission answered from the cache (count only).</summary>
        MetaHit,
        /// <summary>Waiting on a metadata read another request already owns.</summary>
        MetaJoin,
        /// <summary>A metadata read refused for capacity or budget (count only).</summary>
        MetaBusy,
        /// <summary>An admitted metadata read waiting for its running turn.</summary>
        MetaAdmit,
        /// <summary>An admitted metadata read's own work once running.</summary>
        MetaFetch,
        /// <summary>A raw TMDB answer from memory (count only).</summary>
        TmdbHit,
        /// <summary>Waiting on a raw TMDB send already in flight.</summary>
        TmdbJoin,
        /// <summary>Loading raw TMDB answers saved by the server-side cache.</summary>
        TmdbDisk,
        /// <summary>Waiting for one of the raw cache's upstream connection places.</summary>
        TmdbSlot,
        /// <summary>One upstream TMDB HTTP send, body included.</summary>
        TmdbSend,
        /// <summary>An admitted artwork read waiting for its running place.</summary>
        ImageAdmit,
        /// <summary>The viewer's link destinations a native DTO answer is built with.</summary>
        Links,
        /// <summary>Building the response body (DTO or public JSON projection).</summary>
        Project,
        /// <summary>Reading an exact episode out of a projected season (title actions).</summary>
        Parse,
        /// <summary>The privacy guard's final validation of a held answer before and at its start.</summary>
        Publish,
    }

    /// <summary>
    /// A per-request stage recorder: off by default, on with <c>StageTimingsEnabled</c> or <c>JE_STAGE_TIMINGS=1</c>.
    /// Holds a fixed array of stage totals and counts (no strings, keys or identities), flows with the request's
    /// asynchronous work, and is closed when its numbers are written. Work a request starts and another joins is timed for
    /// the request that started it; the joiner records its wait. Stages nest and parallel reads add up, so a stage total can
    /// exceed the request's wall time. Recording never changes what a stage does or the order it publishes in.
    /// </summary>
    internal sealed class StageTimings
    {
        private static readonly string[] Names =
        {
            "policy", "library", "evidence", "discover-evidence", "copies", "feed", "source-hit", "source-map", "source-busy",
            "meta-hit", "meta-join", "meta-busy", "meta-admit", "meta-fetch", "tmdb-hit", "tmdb-join", "tmdb-disk",
            "tmdb-slot", "tmdb-send", "image-admit", "links", "project", "parse", "publish",
        };

        private static readonly AsyncLocal<StageTimings?> Local = new();
        private static readonly bool EnvironmentFlag = Flag(Environment.GetEnvironmentVariable("JE_STAGE_TIMINGS"));

        private readonly long _started = Stopwatch.GetTimestamp();
        private readonly long[] _ticks = new long[Names.Length];
        private readonly int[] _counts = new int[Names.Length];
        private int _closed;

        /// <summary>The current request's recorder, or null (the default: nothing is recorded).</summary>
        internal static StageTimings? Current => Local.Value;

        /// <summary>The number of stages (tests).</summary>
        internal static int StageCount => Names.Length;

        /// <summary>Whether recording is switched on (the admin setting or the environment flag).</summary>
        internal static bool Enabled(Configuration.PluginConfiguration? config) => EnvironmentFlag || config?.StageTimingsEnabled == true;

        internal static bool Flag(string? value)
            => value is { } v && (v.Trim() == "1" || v.Trim().Equals("true", StringComparison.OrdinalIgnoreCase));

        /// <summary>Starts recording for the asynchronous work that follows (the request); returns the recorder.</summary>
        internal static StageTimings Begin()
        {
            var recorder = new StageTimings();
            Local.Value = recorder;
            return recorder;
        }

        /// <summary>Stops recording for the work that follows in this flow (tests and the request's end).</summary>
        internal static void End() => Local.Value = null;

        /// <summary>Times a stage until the returned scope is disposed; a no-op when nothing records.</summary>
        internal static Scope Time(Stage stage) => new(Local.Value, stage);

        /// <summary>Counts a stage that took no measurable time of its own (a cache hit, a busy refusal).</summary>
        internal static void Count(Stage stage) => Local.Value?.Add(stage, 0);

        /// <summary>The same task, timed as <paramref name="stage"/> for this request when it is still running.</summary>
        internal static Task<T> Wait<T>(Task<T> task, Stage stage)
        {
            if (Local.Value is not { } recorder) return task;
            if (task.IsCompleted)
            {
                recorder.Add(stage, 0);
                return task;
            }

            return Timed(task, recorder, stage);
        }

        private static async Task<T> Timed<T>(Task<T> task, StageTimings recorder, Stage stage)
        {
            var started = Stopwatch.GetTimestamp();
            try { return await task.ConfigureAwait(false); }
            finally { recorder.Add(stage, Stopwatch.GetTimestamp() - started); }
        }

        /// <summary>Adds one occurrence of a stage (ignored once the recorder is closed).</summary>
        internal void Add(Stage stage, long ticks)
        {
            if (Volatile.Read(ref _closed) != 0) return;
            var i = (int)stage;
            Interlocked.Add(ref _ticks[i], ticks);
            Interlocked.Increment(ref _counts[i]);
        }

        /// <summary>Whether an absent-title stage was recorded (the privacy guard's publish check alone, which every guarded host answer runs, is not one).</summary>
        internal bool Any
        {
            get
            {
                for (var i = 0; i < _counts.Length; i++)
                {
                    if (i != (int)Stage.Publish && Volatile.Read(ref _counts[i]) != 0) return true;
                }

                return false;
            }
        }

        /// <summary>Total milliseconds and occurrences of a stage (tests).</summary>
        internal (double Ms, int Count) Of(Stage stage)
            => (Ms(Volatile.Read(ref _ticks[(int)stage])), Volatile.Read(ref _counts[(int)stage]));

        /// <summary>Stops taking stages (work still running for a finished request adds nothing).</summary>
        internal void Close() => Interlocked.Exchange(ref _closed, 1);

        /// <summary>
        /// The Server-Timing value: <c>total</c> since the request began, then every recorded stage as
        /// <c>name;dur=ms;desc="n=count"</c>. Only fixed stage names and numbers.
        /// </summary>
        internal string Header()
        {
            var text = new StringBuilder(256);
            text.Append("total;dur=").Append(Ms(Stopwatch.GetTimestamp() - _started).ToString("0.0", CultureInfo.InvariantCulture));
            for (var i = 0; i < Names.Length; i++)
            {
                var count = Volatile.Read(ref _counts[i]);
                if (count == 0) continue;
                text.Append(", ").Append(Names[i]).Append(";dur=")
                    .Append(Ms(Volatile.Read(ref _ticks[i])).ToString("0.0", CultureInfo.InvariantCulture))
                    .Append(";desc=\"n=").Append(count.ToString(CultureInfo.InvariantCulture)).Append('"');
            }

            return text.ToString();
        }

        private static double Ms(long ticks) => ticks * 1000.0 / Stopwatch.Frequency;

        /// <summary>A running stage; disposing it adds the elapsed time (allocation-free; nothing when off).</summary>
        internal readonly struct Scope : IDisposable
        {
            private readonly StageTimings? _recorder;
            private readonly Stage _stage;
            private readonly long _started;

            internal Scope(StageTimings? recorder, Stage stage)
            {
                _recorder = recorder;
                _stage = stage;
                _started = recorder == null ? 0 : Stopwatch.GetTimestamp();
            }

            /// <inheritdoc />
            public void Dispose() => _recorder?.Add(_stage, Stopwatch.GetTimestamp() - _started);
        }
    }
}

using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>
    /// What the current async flow's outbound writes are: automatic work (a queued job of a recipe or list sync, or an old
    /// recipe's own POST to Seerr), or a person's own. Set by the outbox around each send and by the old recipes around
    /// each check, never by a write site. It flows across awaits (an <see cref="AsyncLocal{T}"/>); disposing the scope
    /// restores what was there before, on refusal, cancellation and exceptions too.
    /// </summary>
    public sealed class AutomationTransportContext : IDisposable
    {
        private static readonly AsyncLocal<AutomationTransportContext?> Flow = new();
        private readonly AutomationTransportContext? _parent;

        private AutomationTransportContext(AutomationWriteGate gate, AutomationWrite? write, ISendAdmission? admission)
        {
            _parent = Flow.Value;
            Gate = gate;
            Write = write;
            Admission = admission;
            Flow.Value = this;
        }

        /// <summary>The automatic work of the current async flow (null: none, a person's own work included).</summary>
        public static AutomationTransportContext? Current => Flow.Value is { Write: not null } automatic ? automatic : null;

        internal AutomationWriteGate Gate { get; }

        internal AutomationWrite? Write { get; }

        internal ISendAdmission? Admission { get; }

        /// <summary>
        /// Enters the scope of one job's send or one old recipe's check. A null <paramref name="write"/> (a person's own
        /// request: the gate doesn't apply to it) is entered too, and clears any automatic scope the flow carried, so a
        /// person's request is never checked as someone's automation.
        /// </summary>
        /// <param name="gate">The write gate (reads every setting live).</param>
        /// <param name="write">The automatic work, or null for a person's own.</param>
        /// <param name="admission">The job's per-write budget admission (null: not budgeted).</param>
        /// <returns>The scope; dispose it when the send or check ends.</returns>
        public static AutomationTransportContext Enter(AutomationWriteGate gate, AutomationWrite? write, ISendAdmission? admission = null)
            => new(gate, write, write == null ? null : admission);

        /// <inheritdoc />
        public void Dispose() => Flow.Value = _parent;
    }

    /// <summary>An automatic write refused inside the transport: it was never handed on, so nothing was sent.</summary>
    public sealed class AutomationTransportRefusedException : Exception
    {
        /// <summary>Creates the refusal.</summary>
        /// <param name="hold">The hold the transport check answered.</param>
        public AutomationTransportRefusedException(AutomationHold hold)
            : base(hold.Message) => Hold = hold;

        /// <summary>Why the write is held (the gate's reason, or the live budget's with its next slot).</summary>
        public AutomationHold Hold { get; }
    }

    /// <summary>
    /// The guarantee for automatic writes (D41): on every HttpClient JE sends Sonarr/Radarr and Seerr requests with (the
    /// arr client, the Seerr client and the default one Seerr falls back to), each write (anything but GET, HEAD and
    /// OPTIONS: adds, edits, commands, Seerr's POST) made while <see cref="AutomationTransportContext.Current"/> is set is
    /// checked here, synchronously, as the request is handed on: facts first, then one decision. Every fact read from
    /// storage (the job's budget reservations, the breaker, the eligibility grant, the person's consent, disk facts) is
    /// gathered first, and those reads may wait; then the <see cref="AutomationWriteGate"/> reads the live configuration
    /// and judges every switch, kill, mode and gate on it and those facts, the budgets with their live limits, from memory
    /// only. A fact that may have gone stale while a later one waited is read again first. Nothing waits between that
    /// answer and the inner handler. Refused: the reservations this attempt made are released, and
    /// <see cref="AutomationTransportRefusedException"/> carries the hold to the write site. Reads (read-backs included)
    /// and a person's own writes pass untouched. The write sites' own earlier gate calls stay, as defence in depth.
    /// </summary>
    public sealed class AutomationTransportHandler : DelegatingHandler
    {
        /// <summary>Set on each write the handler checked (tests).</summary>
        internal static readonly HttpRequestOptionsKey<bool> Checked = new("JE.AutomationChecked");

        /// <inheritdoc />
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Check(request);
            return base.SendAsync(request, cancellationToken);
        }

        /// <inheritdoc />
        protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Check(request);
            return base.Send(request, cancellationToken);
        }

        private static void Check(HttpRequestMessage request)
        {
            if (request.Method == HttpMethod.Get || request.Method == HttpMethod.Head || request.Method == HttpMethod.Options) return;
            if (AutomationTransportContext.Current is not { Write: { } write } context) return;
            request.Options.Set(Checked, true);
            // Facts first (the reads that may wait), then one decision on the live settings; the request is handed on as
            // soon as it answers.
            var hold = context.Gate.Check(write, context.Admission);
            if (hold != null)
            {
                context.Admission?.Release();
                throw new AutomationTransportRefusedException(hold);
            }
        }
    }
}

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest
{
    /// <summary>How an automatic request ended.</summary>
    public enum AutoRequestOutcomeKind
    {
        /// <summary>A request was recorded (in the ledger, or sent to Seerr while phase 3 is off).</summary>
        WantRecorded,

        /// <summary>A definitive answer that nothing should be asked for (not in a collection, already there, refused by policy).</summary>
        DefinitiveNoop,

        /// <summary>A lookup or the request itself failed; the answer is unknown and the trigger is retried soon.</summary>
        PreparationFailed,

        /// <summary>The work was stopped (shutdown) before it reached an answer.</summary>
        Cancelled,
    }

    /// <summary>
    /// The typed outcome of one automatic request: a failed TMDB or Seerr lookup is a
    /// <see cref="AutoRequestOutcomeKind.PreparationFailed"/>, never a "nothing to do".
    /// </summary>
    /// <param name="Kind">The outcome kind.</param>
    /// <param name="Reason">A stable reason code.</param>
    /// <param name="TitleKey">The title asked for (or decided about), when known.</param>
    /// <param name="WantId">The want recorded, if any.</param>
    public sealed record AutoRequestOutcome(AutoRequestOutcomeKind Kind, string Reason, string? TitleKey = null, string? WantId = null)
    {
        /// <summary>A request was recorded.</summary>
        public static AutoRequestOutcome Recorded(string reason, string? titleKey = null, string? wantId = null) => new(AutoRequestOutcomeKind.WantRecorded, reason, titleKey, wantId);

        /// <summary>Definitively nothing to ask for.</summary>
        public static AutoRequestOutcome Noop(string reason, string? titleKey = null) => new(AutoRequestOutcomeKind.DefinitiveNoop, reason, titleKey);

        /// <summary>A lookup or the request failed; try again soon.</summary>
        public static AutoRequestOutcome Failed(string reason, string? titleKey = null) => new(AutoRequestOutcomeKind.PreparationFailed, reason, titleKey);

        /// <summary>Stopped before an answer.</summary>
        public static AutoRequestOutcome Cancelled(string reason = "cancelled") => new(AutoRequestOutcomeKind.Cancelled, reason);

        /// <summary>True for an answer that holds until the cooldown ends (recorded or a definitive no-op).</summary>
        public bool Definitive => Kind is AutoRequestOutcomeKind.WantRecorded or AutoRequestOutcomeKind.DefinitiveNoop;

        /// <summary>The kind as stored in the automation log.</summary>
        public string Code => Kind switch
        {
            AutoRequestOutcomeKind.WantRecorded => "want_recorded",
            AutoRequestOutcomeKind.DefinitiveNoop => "definitive_noop",
            AutoRequestOutcomeKind.PreparationFailed => "preparation_failed",
            _ => "cancelled",
        };
    }
}

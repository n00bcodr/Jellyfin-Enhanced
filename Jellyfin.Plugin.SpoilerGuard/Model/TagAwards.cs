namespace Jellyfin.Plugin.SpoilerGuard.Model
{
    /// <summary>Immutable title-level facts; null ranks/years mean unknown, not a score-derived guess.</summary>
    public sealed record TagAwards
    {
        public int? ImdbRank { get; init; }
        public bool CertifiedFresh { get; init; }
        public bool OscarWinner { get; init; }
        public int? OscarYear { get; init; }
        public bool EmmyWinner { get; init; }
        public int? EmmyYear { get; init; }
        public int? LetterboxdRank { get; init; }
    }
}

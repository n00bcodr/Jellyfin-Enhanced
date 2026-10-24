using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// What a response's copy facts were prepared under (D53, edition round 19: every response proven fresh at publication):
    /// the viewer (role, library access, parental settings: their policy revision), the library and item visibility (the
    /// Jellyfin revision), what Hidden Content hides from them, and every edition setting.
    /// </summary>
    /// <param name="User">The viewer.</param>
    /// <param name="Admin">They were an administrator.</param>
    /// <param name="Policy">Their policy revision.</param>
    /// <param name="Library">Jellyfin's library revision (items added, changed, removed: visibility included).</param>
    /// <param name="Hidden">What Hidden Content hides from them, as a stamp ("-": the route doesn't read it).</param>
    /// <param name="Edition">The edition settings (<see cref="EditionAvailability.SemanticRevision"/>).</param>
    /// <param name="Evidence">The parental evidence source, configuration, country and decision revision.</param>
    internal sealed record ResponseStamp(Guid User, bool Admin, string Policy, long Library, string Hidden, string Edition, string Evidence);

    /// <summary>The shared publication fence for decisions derived from a captured parental evidence revision.</summary>
    internal sealed class EvidencePublication
    {
        private readonly Func<string> _current;
        internal EvidencePublication(Func<string> current, Guid? viewer = null, string? revision = null)
        {
            _current = current;
            Revision = revision ?? current();
            Viewer = viewer;
        }

        internal Guid? Viewer { get; }

        internal string Revision { get; }
        internal bool Current => Matches(Revision, _current);
        internal EvidencePublication NextMessage() => new(_current, Viewer);
        internal static bool Matches(string revision, Func<string> current) => revision == current();

        // The callback must be synchronous: a caller cannot carry an admission across another await.
        internal T? Publish<T>(Func<T> project) where T : class
        {
            if (!Current) return null;
            var answer = project();
            return Current ? answer : null;
        }
    }

    /// <summary>
    /// The one response gate of the routes that return copy facts (discover, search, season rows and absent-season rows; the
    /// status routes' <c>GatedAsync</c> is the same rule over the same revisions). A response is prepared across awaits (TMDB,
    /// policy, the arrs) under a stamp; after its last await it is published only for the viewer as Jellyfin has them now, and
    /// only when nothing it was prepared under changed meanwhile: else it is prepared again for the viewer as they are now, or
    /// fails closed. A route that reads Jellyfin's side again at publication (its projection runs after the last await, under
    /// the current viewer) may let the library revision move during the awaits; one whose Jellyfin side was read before them
    /// (an absent page computed by its caller) may not. A stale answer is never cached: callers cache only under a stamp that
    /// held from start to publication.
    /// </summary>
    internal sealed class ResponseGate
    {
        private readonly IArrJellyfinView _view;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<string> _evidence;

        /// <summary>The gate over a Jellyfin view and the settings.</summary>
        /// <param name="view">Jellyfin.</param>
        /// <param name="config">Settings.</param>
        /// <param name="evidence">Current parental evidence revision, when the response depends on absent-title decisions.</param>
        public ResponseGate(IArrJellyfinView view, Func<PluginConfiguration?> config, Func<string>? evidence = null)
        {
            _view = view;
            _config = config;
            _evidence = evidence ?? (() => "-");
        }

        /// <summary>How many times a response is prepared again for a changed viewer before it fails closed.</summary>
        public const int Attempts = ArrStatusService.GateAttempts;

        /// <summary>The stamp of a viewer now.</summary>
        /// <param name="viewer">The viewer.</param>
        /// <param name="hidden">What Hidden Content hides from them ("-": not read by the route).</param>
        public ResponseStamp Take(StatusViewer viewer, string hidden = "-")
            => new(viewer.UserId, viewer.IsAdmin, viewer.PolicyRevision, _view.Revision, hidden, EditionAvailability.SemanticRevision(_config()), _evidence());

        /// <summary>The exact evidence dependency used to prepare this answer, handed to its HTTP commit owner.</summary>
        public EvidencePublication Publication(ResponseStamp prepared) => new(_evidence, prepared.User, prepared.Evidence);

        /// <summary>Whether the captured evidence still holds.</summary>
        public bool EvidenceCurrent(ResponseStamp prepared) => EvidencePublication.Matches(prepared.Evidence, _evidence);

        /// <summary>
        /// The viewer as Jellyfin has them now, when nothing <paramref name="prepared"/> was taken under changed (the library
        /// revision too unless <paramref name="rereadsLibrary"/>); null otherwise (also when they are gone or disabled).
        /// </summary>
        /// <param name="prepared">The stamp the response was prepared under.</param>
        /// <param name="hidden">What Hidden Content hides from them now.</param>
        /// <param name="rereadsLibrary">The route reads Jellyfin's side again at publication.</param>
        public StatusViewer? Current(ResponseStamp prepared, string hidden = "-", bool rereadsLibrary = false)
        {
            if (_view.Viewer(prepared.User) is not { } now) return null;
            var stamp = Take(now, hidden);
            return stamp.Admin == prepared.Admin && string.Equals(stamp.Policy, prepared.Policy, StringComparison.Ordinal)
                && string.Equals(stamp.Hidden, prepared.Hidden, StringComparison.Ordinal) && string.Equals(stamp.Edition, prepared.Edition, StringComparison.Ordinal)
                && EvidenceCurrent(prepared)
                && (rereadsLibrary || stamp.Library == prepared.Library) ? now : null;
        }

        /// <summary>True when nothing changed between two stamps (a publication step that ran with no await in it).</summary>
        /// <param name="a">The first.</param>
        /// <param name="b">The second.</param>
        public static bool Same(ResponseStamp a, ResponseStamp b) => a == b;

        /// <summary>
        /// True when the viewer, Hidden Content and the edition settings are the same in two stamps: a projection that read the
        /// library itself (after the last await) is published even while the library moves on (a scan, a refresh), since what it
        /// read is Jellyfin's own answer for the viewer at that moment; an answer prepared from an earlier read of it is not.
        /// </summary>
        /// <param name="a">The first.</param>
        /// <param name="b">The second.</param>
        public static bool SameViewer(ResponseStamp a, ResponseStamp b) => a with { Library = 0 } == b with { Library = 0 };
    }
}

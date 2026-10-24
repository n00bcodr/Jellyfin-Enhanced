using System;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// The final boundary for home and collection answers. Preparation may await; returning cached bytes or projecting
    /// and serialising an answer must run synchronously inside Publish. A changed policy invalidates all prepared
    /// parental evidence. Callers retry preparation at most three times, then fail closed.
    /// </summary>
    internal sealed class AcquireResponseGate
    {
        internal const int Attempts = 3;
        private readonly IArrJellyfinView _view;
        private readonly Guid _user;
        private readonly Func<StatusViewer, string> _revision;

        internal AcquireResponseGate(IArrJellyfinView view, Guid user, Func<StatusViewer, string> revision)
        {
            _view = view;
            _user = user;
            _revision = revision;
        }

        internal sealed record Policy(StatusViewer Viewer, string Revision);

        internal Policy? Read()
        {
            var viewer = _view.Viewer(_user);
            return viewer == null ? null : new Policy(viewer, viewer.PolicyRevision + "|" + _revision(viewer));
        }

        internal T Publish<T>(Policy prepared, Func<StatusViewer, T> project)
        {
            var current = Read();
            if (current == null || current.Revision != prepared.Revision) throw new Changed();
            var answer = project(current.Viewer);
            if (!EvidencePublication.Matches(prepared.Revision, () => Read()?.Revision ?? string.Empty)) throw new Changed();
            return answer;
        }

        internal sealed class Changed : Exception { }
    }
}

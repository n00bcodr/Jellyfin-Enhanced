using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// Who may see a not-in-library title's native page. One rule for every facade route:
    /// the feature is on, the request mode's metadata source is ready (<see cref="MetadataReady"/>: TMDB in
    /// Jellyfin Enhanced mode, Seerr otherwise), the viewer may use requests (Seerr mode:
    /// a linked, not import-blocked account; JE mode: the request feature), Jellyfin's parental
    /// policy allows the title (fails closed on an unverified rating, like the request path), and the
    /// viewer can open a library the title would land in (RequestPolicy's visibility when the request
    /// feature is on). A refusal answers like a hidden library item: 404.
    /// </summary>
    public sealed class NativeDetailsPolicy
    {
        /// <summary>How a listed title is shown to a viewer (<see cref="Listed"/>).</summary>
        /// <param name="Shown">True when it is shown at all.</param>
        /// <param name="LibraryCopy">The library copy the viewer can open, when it is shown as one.</param>
        public readonly record struct ListedTitle(bool Shown, Guid? LibraryCopy)
        {
            /// <summary>Left out of the list.</summary>
            public static ListedTitle Left => default;

            /// <summary>Shown as a title that isn't in the library (its native details page).</summary>
            public static ListedTitle Absent => new(true, null);

            /// <summary>Shown as the library copy the viewer can open.</summary>
            /// <param name="id">The copy.</param>
            /// <returns>The answer.</returns>
            public static ListedTitle Copy(Guid id) => new(true, id);
        }

        /// <summary>A viewer's access to native details.</summary>
        public enum Access
        {
            /// <summary>Allowed.</summary>
            Allowed,

            /// <summary>Refused (answered like a hidden item).</summary>
            Refused,

            /// <summary>Cannot be verified now (metadata/evidence unavailable or busy): retryable.</summary>
            Unknown,
        }

        /// <summary>Whether a library the title would land in is open to the viewer (<see cref="LibraryVisibility"/>).</summary>
        private enum Visibility
        {
            /// <summary>Open to them.</summary>
            Visible,

            /// <summary>Not open to them (a confirmed refusal).</summary>
            Hidden,

            /// <summary>
            /// Can't be settled now: the person, their policy or the library kept changing under every read
            /// (<c>authorization_changed</c>), the copy lookup stopped before it proved a copy or an absence, or the read
            /// failed. Never shown; answered as temporary (a retryable 503), not as a hidden title's 404.
            /// </summary>
            Unknown,
        }

        private static readonly TimeSpan LibrariesTtl = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan RevisionTtl = TimeSpan.FromSeconds(5);

        private readonly SeerrParentalFilter _parental;
        private readonly INativeDetailsSource _source;
        private readonly IJellyfinLibraryAccess _libraries;
        private readonly IRequestPolicy? _requests;
        private readonly NativeDetailsLibrary? _physical;
        private readonly Helpers.UserAccessCache<Guid, string> _revisions = new(RevisionTtl, 1000);
        private readonly ConcurrentDictionary<Guid, long> _epochs;
        private readonly string? _epochFile;
        private readonly object _epochWrite = new();
        private string _generation;
        private (IReadOnlyList<JfLibraryRoot> Roots, DateTime At)? _roots;

        /// <summary>The file the session epochs are kept in (next to the artwork grant key).</summary>
        internal const string EpochFile = "native-details-revocations.json";

        /// <summary>Creates the policy.</summary>
        /// <param name="parental">Parental filter.</param>
        /// <param name="source">Metadata source.</param>
        /// <param name="libraries">Library roots.</param>
        /// <param name="requests">Request policy (request visibility), when the request feature exists.</param>
        /// <param name="stateDirectory">
        /// Folder for the session epochs (the plugin's data folder, where the grant key is kept), or null
        /// to keep them in memory only. They must outlive a restart exactly when the key does: otherwise a
        /// grant ended by a sign-out would verify again once the epoch is back at zero.
        /// </param>
        /// <param name="physical">
        /// What the library itself holds of a title (copies, seasons, episodes Jellyfin hides from the
        /// viewer), or null when nothing is checked (no library).
        /// </param>
        public NativeDetailsPolicy(SeerrParentalFilter parental, INativeDetailsSource source, IJellyfinLibraryAccess libraries, IRequestPolicy? requests = null, string? stateDirectory = null, NativeDetailsLibrary? physical = null)
        {
            _parental = parental;
            _source = source;
            _libraries = libraries;
            _requests = requests;
            _physical = physical;
            _epochFile = string.IsNullOrWhiteSpace(stateDirectory) ? null : System.IO.Path.Combine(stateDirectory, EpochFile);
            (_epochs, _generation) = LoadEpochs(_epochFile);
        }

        /// <summary>True when the admin setting is on (the facade answers nothing otherwise).</summary>
        public static bool FeatureEnabled(PluginConfiguration? config) => config?.NativeAbsentDetailsEnabled == true;

        /// <summary>True when Seerr is configured (the proof's only metadata source).</summary>
        public static bool SeerrConfigured(PluginConfiguration config)
            => config.JellyseerrEnabled && !string.IsNullOrWhiteSpace(config.JellyseerrUrls) && !string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey());

        /// <summary>True when the phase-3 request feature runs in Jellyfin Enhanced mode (no Seerr account needed).</summary>
        public static bool JeMode(PluginConfiguration config)
            => config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled && config.ArrRequestBackend == "je";

        /// <summary>
        /// True when Jellyfin Enhanced is the selected request backend, whatever the rollout switches say (Requests &amp;
        /// downloads, A1/BEH-02): native details then read TMDB and never Seerr, even with Seerr settings still stored
        /// (a strict-JE server answers every Seerr route with <c>backend_disabled</c>).
        /// </summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether the JE backend is selected.</returns>
        public static bool JeBackend(PluginConfiguration config) => config.ArrRequestBackend == "je";

        /// <summary>
        /// True when the Jellyfin Enhanced backend has its own metadata source for native details: TMDB through Jellyfin
        /// Enhanced's key (Requests &amp; downloads, A1). Seerr's settings play no part.
        /// </summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether JE's metadata is ready.</returns>
        public static bool JeMetadataReady(PluginConfiguration config) => JeBackend(config) && !string.IsNullOrWhiteSpace(config.GetTmdbApiKey());

        /// <summary>
        /// True when native details have a metadata source in the request mode in effect: TMDB in Jellyfin Enhanced mode
        /// (<see cref="JeMetadataReady"/>; Seerr is never read there, configured or not), Seerr in every other mode
        /// (<see cref="SeerrConfigured"/>, as before). The one readiness rule for the pages, their feeds, the home
        /// sections and the client's capability.
        /// </summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether a metadata source is ready.</returns>
        public static bool MetadataReady(PluginConfiguration config) => JeBackend(config) ? JeMetadataReady(config) : SeerrConfigured(config);

        /// <summary>
        /// True when a title's public details (details, ratings, a movie collection's parts) are answered:
        /// native pages are on, or Jellyfin Enhanced is the request backend, where the more-info window reads
        /// them instead of Seerr (native pages or not; A1/BEH-02).
        /// </summary>
        public static bool PublicDetailsEnabled(PluginConfiguration? config) => FeatureEnabled(config) || (config != null && JeBackend(config));

        /// <summary>Whether the viewer may see this title's page (and its children).</summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="title">Any synthetic id of the title (season/episode ids are judged by their series).</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>True when allowed.</returns>
        public async Task<bool> MaySeeAsync(User viewer, SyntheticId title, CancellationToken ct)
            => await SeeAsync(viewer, title, ct).ConfigureAwait(false) == Access.Allowed;

        /// <summary>
        /// <see cref="MaySeeAsync"/> that tells a refusal from a check that can't be made right now
        /// (the Seerr link of a viewer while Seerr is unreachable): the page answers 404 for the first and
        /// a retryable 503 for the second, so an outage falls back to the modal instead of refusing.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="title">Any synthetic id of the title.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The access.</returns>
        public Task<Access> SeeAsync(User viewer, SyntheticId title, CancellationToken ct) => SeeAsync(viewer, title, false, ct);

        /// <summary>
        /// <see cref="SeeAsync(User, SyntheticId, CancellationToken)"/> for a title's public details only (no page,
        /// row or artwork): the same rule, admitted while <see cref="PublicDetailsEnabled"/> holds.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="title">Any synthetic id of the title.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The access.</returns>
        public Task<Access> SeeDetailsAsync(User viewer, SyntheticId title, CancellationToken ct) => SeeAsync(viewer, title, true, ct);

        private async Task<Access> SeeAsync(User viewer, SyntheticId title, bool details, CancellationToken ct)
        {
            if (!title.IsTitle) return Access.Refused;
            using var timed = StageTimings.Time(Stage.Policy);
            var access = await ViewerAccessAsync(viewer, details, ct).ConfigureAwait(false);
            if (access != Access.Allowed) return access;
            // The person as the caller read them decides the parental part too (no second read of them) when request
            // visibility's fresh final read can confirm that read is the person now. Only a decision so confirmed is
            // answered: when the stamp doesn't confirm the read, the person is read again and the whole decision (viewer
            // rule, parental, request visibility, the library's copies and hidden seasons and episodes) is made again from
            // that read, confirmed the same way. A person (or a library) who keeps changing through three reads is never
            // answered from any of them: the decision is unknown for now (a retryable 503), not a hidden title's 404; a
            // person who is gone or disabled is refused.
            if (HeldReadsConfirmable())
            {
                for (var attempt = 0; attempt < Confirmations; attempt++)
                {
                    if (attempt > 0)
                    {
                        if (_parental.ReadAgain(viewer.Id) is not { } fresh) return Access.Refused;
                        access = await ViewerAccessAsync(fresh, details, ct).ConfigureAwait(false);
                        if (access != Access.Allowed) return access;
                        viewer = fresh;
                    }

                    var (decided, current) = await TitleAccessAsync(viewer, title, true, ct).ConfigureAwait(false);
                    if (current) return decided;
                }

                return Access.Unknown;
            }

            return (await TitleAccessAsync(viewer, title, false, ct).ConfigureAwait(false)).Access;
        }

        /// <summary>How many reads of the person a title decision tries before it refuses a person who keeps changing.</summary>
        private const int Confirmations = 3;

        /// <summary>
        /// The title part of <see cref="SeeAsync(User, SyntheticId, bool, CancellationToken)"/>. <paramref name="held"/>: the
        /// parental policy comes from <paramref name="viewer"/> as read, and the answer's <c>Current</c> says whether request
        /// visibility's fresh final read confirmed it; otherwise the person is read again for it (<c>Current</c> is true).
        /// </summary>
        private async Task<(Access Access, bool Current)> TitleAccessAsync(User viewer, SyntheticId title, bool held, CancellationToken ct)
        {
            var mediaType = title.IsMovie ? "movie" : "tv";
            var id = viewer.Id.ToString("N");
            // Fails closed for restricted users when the rating can't be verified (same rule as asking).
            // A2 owned-copy exemption: keep the following library and exact season/episode visibility checks.
            if (!(held ? _parental.MayOpenLocal(mediaType, title.TmdbId, viewer) : _parental.MayOpenLocal(mediaType, title.TmdbId, id))
                && !await (held ? _parental.MaySeeAbsentAsync(mediaType, title.TmdbId, viewer, ct) : _parental.MaySeeAbsentAsync(mediaType, title.TmdbId, id, ct)).ConfigureAwait(false))
            {
                // A known hidden native copy is a refusal even when public parental facts remain unavailable.
                var visible = LibraryVisibility(viewer, title, held, out var confirmed);
                var copies = Physical(viewer, title);
                if (visible == Visibility.Hidden || (!copies.Unreadable && copies.Hides(title))) return (Access.Refused, confirmed);
                var verdict = held ? _parental.AbsentVerdict(mediaType, title.TmdbId, viewer) : _parental.AbsentVerdict(mediaType, title.TmdbId, id);
                return (JellyfinEnhanced.Instance?.Configuration is { } config && JeBackend(config) && verdict == null ? Access.Unknown : Access.Refused, confirmed);
            }
            using var library = StageTimings.Time(Stage.Library);
            var shown = LibraryVisibility(viewer, title, held, out var current);
            return (Decide(shown, Physical(viewer, title), title), current);
        }

        /// <summary>
        /// The library part of a title decision: a confirmed refusal (not open to the viewer, or a copy, season or episode
        /// the library hides from them) is final; visibility or a library that can't be settled now is temporary; else allowed.
        /// </summary>
        private static Access Decide(Visibility shown, PhysicalTitle copies, SyntheticId title)
        {
            if (shown == Visibility.Hidden || (!copies.Unreadable && copies.Hides(title))) return Access.Refused;
            return shown == Visibility.Unknown || copies.Unreadable ? Access.Unknown : Access.Allowed;
        }

        /// <summary>
        /// Whether the viewer may open a page a title links to that isn't a title: a person's page, or the
        /// discovery page of a genre, studio or network. These hold public data only (a biography, a name)
        /// and their titles come from discovery rows filtered for the viewer, so the viewer-level rule
        /// applies (the feature, Seerr, the viewer's link); a person TMDB marks as an adult performer is
        /// refused to a viewer with a parental limit (see <see cref="PersonAllowed"/>).
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="page">A person, genre, studio or network id.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The access.</returns>
        public async Task<Access> SeeLinkedPageAsync(User viewer, SyntheticId page, CancellationToken ct)
        {
            if (page.IsTitle) return Access.Refused;
            return await ViewerAccessAsync(viewer, ct).ConfigureAwait(false);
        }

        /// <summary>
        /// True when a person's page may be shown to the viewer: TMDB's adult flag (adult performers) refuses
        /// it to viewers with any parental limit, as a title outside their rating would be.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="person">Seerr's person details.</param>
        /// <returns>True when allowed.</returns>
        public static bool PersonAllowed(User viewer, JsonElement person)
            => !(person.ValueKind == JsonValueKind.Object && person.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True)
               || !ArrJellyfinView.HasParentalLimit(viewer);

        /// <summary>
        /// What the library holds of the title for this viewer: its copies, and the seasons and episodes
        /// (of <paramref name="title"/>'s season) Jellyfin hides from them. A synthetic page, row or image
        /// never stands in for one of those.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="title">Any synthetic id of the title.</param>
        /// <returns>The physical title (<see cref="PhysicalTitle.None"/> when there is no copy).</returns>
        public PhysicalTitle Physical(User viewer, SyntheticId title)
            => Physical(viewer, title.IsMovie, title.TmdbId, title.Kind is SyntheticKind.Season or SyntheticKind.Episode ? title.Season : null);

        /// <summary><see cref="Physical(User, SyntheticId)"/> for a title and, optionally, one of its seasons.</summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <param name="season">The season whose hidden episodes are wanted, or null.</param>
        /// <param name="everySeason">A series with no <paramref name="season"/>: the hidden episodes of every season too (its status page).</param>
        /// <returns>The physical title.</returns>
        public PhysicalTitle Physical(User viewer, bool movie, int tmdb, int? season, bool everySeason = false)
        {
            if (_physical == null) return PhysicalTitle.None;
            try
            {
                return _physical.Read(viewer, Revision(viewer), movie, tmdb, season, everySeason);
            }
            catch (Exception)
            {
                // The library can't be read: nothing may stand in for what it might hide, and nothing is known to be hidden.
                return new PhysicalTitle { Hidden = true, Unreadable = true };
            }
        }

        /// <summary>
        /// <see cref="Physical(User, bool, int, int?, bool)"/> asked under every id the caller knows the title by (TMDB,
        /// TVDB, IMDb: the list import's physical-title projection, review round 2), with this policy's viewer revision.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="keys">Every key of the title.</param>
        /// <param name="season">The season whose hidden episodes are wanted, or null.</param>
        /// <returns>The physical title (hidden when the library can't be read).</returns>
        public PhysicalTitle Physical(User viewer, bool movie, IReadOnlyCollection<TitleKey> keys, int? season)
        {
            if (_physical == null) return PhysicalTitle.None;
            try
            {
                return _physical.Read(viewer, Revision(viewer), movie, keys, season);
            }
            catch (Exception)
            {
                return new PhysicalTitle { Hidden = true, Unreadable = true };
            }
        }

        /// <summary>The library reader's <see cref="NativeDetailsLibrary.HoldsCopiesWithout"/> (true when it can't be asked).</summary>
        /// <param name="movie">Movies (else series).</param>
        /// <param name="providers">Providers of the ids at hand.</param>
        /// <returns>True when copies exist that none of those ids can find.</returns>
        public bool HoldsCopiesWithout(bool movie, IReadOnlyCollection<string> providers)
        {
            if (_physical == null) return false;
            try
            {
                return _physical.HoldsCopiesWithout(movie, providers);
            }
            catch (Exception)
            {
                return true;
            }
        }

        /// <summary>
        /// The viewer-level part of <see cref="MaySeeAsync"/>, the same for every title: the feature is on,
        /// the viewer is enabled, the metadata source is ready and (Seerr mode) the viewer is linked and not
        /// import-blocked. Artwork requests re-run it, since grants outlive the page that minted them.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>True when the viewer may use native details at all.</returns>
        public async Task<bool> ViewerMayUseAsync(User viewer, CancellationToken ct)
            => await ViewerAccessAsync(viewer, ct).ConfigureAwait(false) == Access.Allowed;

        /// <summary><see cref="ViewerMayUseAsync"/> that tells an unknown Seerr link from a refusal.</summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The access.</returns>
        public Task<Access> ViewerAccessAsync(User viewer, CancellationToken ct) => ViewerAccessAsync(viewer, false, ct);

        /// <summary>
        /// <see cref="ViewerAccessAsync(User, CancellationToken)"/> for a title's public details only, admitted
        /// while <see cref="PublicDetailsEnabled"/> holds (so in Jellyfin Enhanced mode with native pages off).
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The access.</returns>
        public Task<Access> DetailsAccessAsync(User viewer, CancellationToken ct) => ViewerAccessAsync(viewer, true, ct);

        private async Task<Access> ViewerAccessAsync(User viewer, bool details, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!(details ? PublicDetailsEnabled(config) : FeatureEnabled(config)) || viewer.HasPermission(PermissionKind.IsDisabled)) return Access.Refused;
            if (!MetadataReady(config!)) return Access.Refused;
            // The JE backend (A1/BEH-02): no Seerr account is asked for, so Seerr is never read here.
            if (JeBackend(config!)) return Access.Allowed;
            if (ImportBlocked(config!, viewer)) return Access.Refused;
            return await _source.IsSeerrLinkedAsync(viewer.Id, ct).ConfigureAwait(false) switch
            {
                true => Access.Allowed,
                false => Access.Refused,
                null => Access.Unknown,
            };
        }

        /// <summary>
        /// Ends every artwork grant minted for a user (their session ended: sign-out, or the session was
        /// removed): the policy revision the grants carry moves on, so already-rendered image URLs stop
        /// working and a new page view mints new ones.
        /// </summary>
        /// <param name="userId">The user.</param>
        public void Revoke(Guid userId)
        {
            if (userId == Guid.Empty) return;
            _epochs.AddOrUpdate(userId, 1, (_, epoch) => epoch + 1);
            // Also ends a revision being computed right now (it may have read the epoch before this).
            _revisions.Invalidate(userId);
            if (!SaveEpochs())
            {
                // The sign-out isn't on disk: a restart would read the epochs from before it. Remove the
                // file, so the next start can't trust anything and begins a new generation (every grant
                // minted before ends). Until then the epoch holds in memory.
                TryDelete(_epochFile);
            }
        }

        /// <summary>The persisted epochs file shape: a generation every grant carries, and the per-user epochs.</summary>
        private sealed class EpochState
        {
            public string? Generation { get; set; }

            public Dictionary<string, long>? Epochs { get; set; }
        }

        /// <summary>
        /// The kept session epochs and their generation. Revocation state that can't be trusted fails
        /// closed: no file (first start, or one removed after a failed write), an unreadable one, or one
        /// that can't be written back now (a sign-out after this start couldn't be kept either) starts a
        /// new generation, which ends every grant minted before (the grant key alone decides nothing).
        /// </summary>
        private (ConcurrentDictionary<Guid, long> Epochs, string Generation) LoadEpochs(string? file)
        {
            var epochs = new ConcurrentDictionary<Guid, long>();
            var fresh = NewGeneration();
            if (file == null) return (epochs, fresh);
            string? generation = null;
            try
            {
                if (System.IO.File.Exists(file))
                {
                    var stored = JsonSerializer.Deserialize<EpochState>(System.IO.File.ReadAllText(file));
                    if (stored?.Generation is { Length: > 0 } g && stored.Epochs != null)
                    {
                        foreach (var (user, epoch) in stored.Epochs)
                        {
                            if (Guid.TryParseExact(user, "N", out var id) && id != Guid.Empty && epoch > 0) epochs[id] = epoch;
                        }

                        generation = g;
                    }
                }
            }
            catch (Exception)
            {
                generation = null;
            }

            if (generation == null) epochs.Clear();
            var kept = generation ?? fresh;
            // Written back at once: a start that can't keep its state can't keep a later sign-out either.
            return Write(file, epochs, kept) ? (epochs, kept) : (epochs, fresh);
        }

        private static string NewGeneration() => Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8));

        /// <summary>Keeps the session epochs (owner-only file, replaced whole), so a restart doesn't undo a sign-out.</summary>
        /// <returns>False when they couldn't be written.</returns>
        private bool SaveEpochs() => _epochFile == null || Write(_epochFile, _epochs, _generation);

        private bool Write(string file, ConcurrentDictionary<Guid, long> epochs, string generation)
        {
            lock (_epochWrite)
            {
                try
                {
                    var snapshot = new EpochState
                    {
                        Generation = generation,
                        Epochs = epochs.ToDictionary(e => e.Key.ToString("N", CultureInfo.InvariantCulture), e => e.Value),
                    };
                    System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
                    var temp = file + ".tmp";
                    System.IO.File.WriteAllText(temp, JsonSerializer.Serialize(snapshot));
                    if (!OperatingSystem.IsWindows()) System.IO.File.SetUnixFileMode(temp, System.IO.UnixFileMode.UserRead | System.IO.UnixFileMode.UserWrite);
                    System.IO.File.Move(temp, file, overwrite: true);
                    return true;
                }
                catch (Exception)
                {
                    return false;
                }
            }
        }

        private static void TryDelete(string? file)
        {
            if (file == null) return;
            try
            {
                System.IO.File.Delete(file);
            }
            catch (Exception)
            {
                // A read-only folder: the next start can't write back the stale file either, so it fails closed there.
            }
        }

        /// <summary>
        /// The title-level part of <see cref="MaySeeAsync"/> without network I/O, for titles a page lists
        /// (the Similar rail) or draws (artwork): the parental decision from the rating cache (a
        /// restricted viewer needs a verified rating, so an unknown one hides the title) and library
        /// or request visibility. A title listed here is one whose own page the viewer may open.
        /// </summary>
        /// <param name="viewer">The effective viewer (viewer-level checks already passed).</param>
        /// <param name="title">Any synthetic id of the title.</param>
        /// <returns>True when the title may be shown.</returns>
        public bool MayListAbsent(User viewer, SyntheticId title)
        {
            // As in SeeAsync: only a decision whose read the fresh final stamp confirmed is answered; an unconfirmed read is
            // replaced by a fresh read for the whole decision, confirmed the same way, and a person who keeps changing is left out.
            for (var attempt = 0; attempt < Confirmations; attempt++)
            {
                var shown = MayListAbsent(viewer, title, true, out var stale);
                if (!stale) return shown;
                if (ReadAgain(viewer) is not { } fresh) return false;
                viewer = fresh;
            }

            return false;
        }

        /// <summary>
        /// <see cref="MayListAbsent(User, SyntheticId)"/>. <paramref name="held"/>: the person as the caller read them, while
        /// request visibility's fresh final read confirms them (a refusal from that read stands: it fails closed);
        /// <paramref name="stale"/> is true (and the answer is no) when it didn't. Otherwise the parental part reads the
        /// person by id and the library parts use <paramref name="viewer"/>.
        /// </summary>
        private bool MayListAbsent(User viewer, SyntheticId title, bool held, out bool stale)
        {
            stale = false;
            if (!title.IsTitle) return false;
            var mediaType = title.IsMovie ? "movie" : "tv";
            if (held && HeldReadsConfirmable())
            {
                if (!_parental.MaySeeAbsent(mediaType, title.TmdbId, viewer, out _)) return false;
                var visible = LibraryVisible(viewer, title, true, out var current);
                if (current) return visible && !Physical(viewer, title).Hides(title);
                stale = true;
                return false;
            }

            if (!_parental.MaySeeAbsent(mediaType, title.TmdbId, viewer.Id.ToString("N"), out _)) return false;
            return LibraryVisible(viewer, title) && !Physical(viewer, title).Hides(title);
        }

        /// <summary>The person read again (null when unknown, deleted or disabled): the fallback of a read not confirmed current.</summary>
        private User? ReadAgain(User viewer) => _parental.ReadAgain(viewer.Id);

        /// <summary>
        /// <see cref="MayListAbsent"/> that reads a rating the parental cache doesn't hold (a restart, an
        /// expired entry) instead of refusing: artwork grants outlive the page and the server process that
        /// minted them. Shared and bounded like the page's own check; fails closed.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="title">Any synthetic id of the title.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>True when the title may be shown.</returns>
        public async Task<bool> MayListAbsentAsync(User viewer, SyntheticId title, CancellationToken ct)
            => await ListAbsentAccessAsync(viewer, title, ct).ConfigureAwait(false) == Access.Allowed;

        /// <summary>Artwork revalidation keeps transient evidence/admission failure distinct from refusal.</summary>
        public async Task<Access> ListAbsentAccessAsync(User viewer, SyntheticId title, CancellationToken ct)
        {
            if (MayListAbsent(viewer, title)) return Access.Allowed;
            if (!title.IsTitle) return Access.Refused;
            using var timed = StageTimings.Time(Stage.Policy);
            var evidence = await _parental.CheckAbsentAsync(title.IsMovie ? "movie" : "tv", title.TmdbId, viewer.Id.ToString("N"), ct).ConfigureAwait(false);
            if (evidence == null) return JellyfinEnhanced.Instance?.Configuration is { } config && JeBackend(config) ? Access.Unknown : Access.Refused;
            if (!evidence.Value) return Access.Refused;
            return Decide(LibraryVisibility(viewer, title, false, out _), Physical(viewer, title), title);
        }

        /// <summary>
        /// How a title a list names (a filmography, a discovery feed) is shown to the viewer, judged by the
        /// library first: the library copy they can open (a library card), or, with no copy anywhere, the
        /// absent title when its own page would open for them (<see cref="MayListAbsent"/>: the cached
        /// parental decision, library or request visibility); otherwise nothing. A copy Jellyfin hides
        /// from them is never shown as absent instead. No network I/O: a restricted viewer's ratings must
        /// be in the parental cache already (the list was run through the parental filter first).
        /// </summary>
        /// <param name="viewer">The effective viewer (viewer-level checks already passed).</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <returns>The library copy to link to, an absent title, or nothing.</returns>
        public ListedTitle Listed(User viewer, bool movie, int tmdb)
        {
            // A read the fresh final stamp didn't confirm: the whole answer again (copies too) from a fresh read of the
            // person, confirmed the same way; a person who keeps changing is left out.
            for (var attempt = 0; attempt < Confirmations; attempt++)
            {
                var listed = Listed(viewer, movie, tmdb, true, out var stale);
                if (!stale) return listed;
                if (ReadAgain(viewer) is not { } fresh) return ListedTitle.Left;
                viewer = fresh;
            }

            return ListedTitle.Left;
        }

        /// <summary><see cref="Listed(User, bool, int)"/>; <paramref name="held"/> and <paramref name="stale"/> as in <see cref="MayListAbsent(User, SyntheticId, bool, out bool)"/>.</summary>
        private ListedTitle Listed(User viewer, bool movie, int tmdb, bool held, out bool stale)
        {
            stale = false;
            if (tmdb <= 0) return ListedTitle.Left;
            PhysicalTitle copies;
            try
            {
                copies = _physical?.ReadCopies(viewer, Revision(viewer), movie, tmdb) ?? PhysicalTitle.None;
            }
            catch (Exception)
            {
                // The library can't be read: nothing may stand in for what it might hide.
                return ListedTitle.Left;
            }

            if (copies.Shown.Count > 0) return ListedTitle.Copy(copies.Shown[0]);
            if (copies.Copies.Count > 0) return ListedTitle.Left;
            return MayListAbsent(viewer, movie ? SyntheticId.Movie(tmdb) : SyntheticId.Series(tmdb), held, out stale) ? ListedTitle.Absent : ListedTitle.Left;
        }

        private static bool ImportBlocked(PluginConfiguration config, User viewer)
            => JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers).Contains(viewer.Id.ToString("N"));

        private static bool RequestsOn(PluginConfiguration config)
            => config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled && config.ArrRequestBackend is "je" or "seerr";

        /// <summary>
        /// True when request visibility decides library visibility (<see cref="LibraryVisible(User, SyntheticId, bool, out bool)"/>):
        /// its final authorization stamp reads the person fresh, so it can confirm a read the caller made.
        /// </summary>
        private bool HeldReadsConfirmable() => _requests != null && JellyfinEnhanced.Instance?.Configuration is { } config && RequestsOn(config);

        /// <summary>Whether the viewer can open a library the title would land in (request visibility when requests are on).</summary>
        private bool LibraryVisible(User viewer, SyntheticId title) => LibraryVisible(viewer, title, false, out _);

        /// <summary><see cref="LibraryVisibility"/> for a list (shown or left out): anything not confirmed visible is left out.</summary>
        private bool LibraryVisible(User viewer, SyntheticId title, bool held, out bool current)
            => LibraryVisibility(viewer, title, held, out current) == Visibility.Visible;

        /// <summary>
        /// Whether the viewer can open a library the title would land in (request visibility when requests are on).
        /// <paramref name="held"/>: request visibility starts from <paramref name="viewer"/> as read, and
        /// <paramref name="current"/> is true only when its fresh final read confirmed that read (every authorization fact of
        /// the person, their parental policy among them, is the person's now). Otherwise the person is read again and
        /// <paramref name="current"/> is true. Request visibility that couldn't be settled (its own three reads never agreed:
        /// <c>authorization_changed</c>; a copy lookup that proved neither a copy nor an absence; a failed read) is
        /// <see cref="Visibility.Unknown"/>, never visible.
        /// </summary>
        private Visibility LibraryVisibility(User viewer, SyntheticId title, bool held, out bool current)
        {
            current = !held;
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return Visibility.Hidden;
            if (RequestsOn(config) && _requests != null)
            {
                try
                {
                    var input = new MutationInput
                    {
                        Key = (title.IsMovie ? "movie" : "tv") + ":tmdb:" + title.TmdbId.ToString(CultureInfo.InvariantCulture),
                        Scope = title.IsMovie ? "movie" : "seasons",
                    };
                    var facts = held ? _requests.Evaluate(viewer, input, out current) : _requests.Evaluate(viewer.Id, input);
                    if (facts.Visible) return Visibility.Visible;
                    return facts.Refusal == "authorization_changed" || facts.CopiesUnproven ? Visibility.Unknown : Visibility.Hidden;
                }
                catch (Exception)
                {
                    current = !held;
                    return Visibility.Unknown;
                }
            }

            return CanOpenLibraryFor(viewer, title.IsMovie) ? Visibility.Visible : Visibility.Hidden;
        }

        /// <summary>True when the viewer can open at least one library a title of this kind lands in.</summary>
        /// <param name="viewer">Viewer.</param>
        /// <param name="movie">Movie (else series).</param>
        /// <returns>True when such a library is open to them.</returns>
        public bool CanOpenLibraryFor(User viewer, bool movie)
        {
            var roots = Roots();
            foreach (var root in roots)
            {
                var fits = root.CollectionType is null or "mixed" || root.CollectionType == (movie ? "movies" : "tvshows");
                if (fits && Guid.TryParse(root.Id, out var id) && id != Guid.Empty && ArrInstanceLibraries.CanOpen(viewer, new[] { id })) return true;
            }

            return false;
        }

        /// <summary>
        /// The viewer's policy revision: parental limit and tag rules, library access, every other
        /// access-deciding fact of the viewer (<see cref="Helpers.UserAuthority.Fingerprint"/>), the feature
        /// switch, Seerr configuration, the request mode, the viewer's import block and their session
        /// epoch (<see cref="Revoke"/>) with the epochs' generation. Artwork grants
        /// carry it; any change ends the grants minted before. (Seerr linkage and per-title request
        /// visibility are checked again on each artwork request instead.)
        /// </summary>
        /// <param name="viewer">Viewer.</param>
        /// <returns>An opaque revision string.</returns>
        public string Revision(User viewer)
        {
            // The memo is keyed by the viewer as just read (every access-deciding fact, Helpers.UserAuthorityFields)
            // and the person's own Jellyfin user version: a change made a moment ago (10.11 saves a policy with no
            // event) ends the grants on the next request, not when the memo expires.
            var ticket = _revisions.Begin(viewer);
            if (_revisions.TryGet(viewer.Id, ticket.Authority, out var hit)) return hit;
            var authority = ticket.Authority;

            var config = JellyfinEnhanced.Instance?.Configuration;
            var text = JsonSerializer.Serialize(SeerrParentalFilter.PolicyFor(viewer))
                + "|" + viewer.HasPermission(PermissionKind.EnableAllFolders)
                + "|" + string.Join(',', viewer.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders).OrderBy(g => g))
                + "|" + string.Join(',', viewer.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders).OrderBy(g => g))
                + "|" + viewer.HasPermission(PermissionKind.IsDisabled)
                + "|" + FeatureEnabled(config)
                // The metadata source is ready (Seerr mode: Seerr configured, the same fact as before).
                + "|" + (config != null && MetadataReady(config))
                + "|" + (config != null && JeMode(config)) + "|" + (config != null && RequestsOn(config))
                // The JE backend selected (Seerr mode's text stays as it was).
                + (config != null && JeBackend(config) ? "|je" : string.Empty)
                + "|" + (config != null && ImportBlocked(config, viewer))
                + "|" + _generation + "." + _epochs.GetValueOrDefault(viewer.Id).ToString(CultureInfo.InvariantCulture)
                // Any other access-deciding change ends the grants too.
                + "|" + authority;
            var revision = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text))).Substring(0, 16);
            _revisions.Set(viewer.Id, ticket, revision);
            return revision;
        }

        private IReadOnlyList<JfLibraryRoot> Roots()
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var cached = _rootsFacts;
            if (cached is { } c && DateTime.UtcNow - c.At < LibrariesTtl) return c.Roots;
            var roots = _libraries.Libraries();
            _rootsFacts = (roots, DateTime.UtcNow);
            return roots;
        }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<(IReadOnlyList<JfLibraryRoot> Roots, DateTime At)?> _rootsFactsOwner = new();
        private (IReadOnlyList<JfLibraryRoot> Roots, DateTime At)? _rootsFacts { get => _rootsFactsOwner.Read(ref _roots, () => default!); set => _rootsFactsOwner.Store(ref _roots, value); }
    }
}

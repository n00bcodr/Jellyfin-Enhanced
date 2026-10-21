using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages
{
    /// <summary>What the server's metadata read said about a placeholder's poster.</summary>
    public enum ListCollagePosterReadState
    {
        /// <summary>A complete server read gave this poster for exactly this title.</summary>
        Verified = 0,

        /// <summary>A complete server read found the title has no poster (final until the title changes).</summary>
        KnownNoPoster = 1,

        /// <summary>The read failed (for a season: its own read, whatever the show's said). Retried later.</summary>
        ReadFailed = 2,

        /// <summary>Only part of the title's metadata was read. Retried later.</summary>
        Partial = 3,

        /// <summary>The source didn't answer (or isn't configured). Retried later.</summary>
        Unavailable = 4,

        /// <summary>Only a client-sent poster exists (custom entry, no TMDB id, never checked).</summary>
        NotVerified = 5,
    }

    /// <summary>One viewer's current artwork decision for one placeholder, from the privacy owner.</summary>
    public enum ListCollageArtworkVerdict
    {
        /// <summary>Not decided (lookup failed, over budget, no answer): left out, retried.</summary>
        Unknown = 0,

        /// <summary>The viewer may see this title's poster.</summary>
        Allowed = 1,

        /// <summary>Hidden Content or parental controls hide the title from the viewer.</summary>
        Hidden = 2,

        /// <summary>Spoiler Guard guards the title's artwork for the viewer.</summary>
        Guarded = 3,

        /// <summary>A collection-level artwork rule denies it.</summary>
        CollectionArtworkDenied = 4,

        /// <summary>A pending-TMDB rule (protection that applies on arrival) denies it.</summary>
        PendingTmdbArtworkDenied = 5,
    }

    /// <summary>The outcome of selecting one viewer's posters.</summary>
    public enum ListCollageSelectionStatus
    {
        /// <summary>At least one poster is allowed.</summary>
        Selected = 0,

        /// <summary>No poster is allowed.</summary>
        Empty = 1,

        /// <summary>The viewer isn't a known person with a readable policy: nothing is selected.</summary>
        ViewerUnknown = 2,

        /// <summary>Not a playlist or collection.</summary>
        Unsupported = 3,
    }

    /// <summary>
    /// The server's poster evidence for one placeholder: the title it was read for (kind, TMDB id, season) and the result.
    /// Only <see cref="ListCollagePosterReadState.Verified"/> evidence for exactly the placeholder's title is poster
    /// authority; a client-sent <see cref="Placeholder.PosterPath"/> never is.
    /// </summary>
    /// <param name="PlaceholderId">The placeholder.</param>
    /// <param name="Kind">The <see cref="PlaceholderKinds"/> the read was for.</param>
    /// <param name="TmdbId">The TMDB id the read was for.</param>
    /// <param name="SeasonNumber">The season the read was for (seasons only).</param>
    /// <param name="State">What the read said.</param>
    /// <param name="ServerPosterPath">The server's poster path (TMDB form, e.g. <c>/abc.jpg</c>).</param>
    public sealed record ListCollagePosterEvidence(string PlaceholderId, string Kind, int? TmdbId, int? SeasonNumber, ListCollagePosterReadState State, string? ServerPosterPath)
    {
        /// <summary>
        /// Evidence from the list metadata read (<see cref="ListMetadataService.FetchAsync"/>; complete-only cache): no
        /// answer is unavailable, a failed season read is a failed read (the show's poster it carries is not used),
        /// another partial read is partial, a complete read gives the poster or a known absence.
        /// </summary>
        /// <param name="placeholder">The placeholder the read was for.</param>
        /// <param name="metadata">The read, or null when the source didn't answer.</param>
        /// <returns>The evidence.</returns>
        public static ListCollagePosterEvidence FromMetadata(Placeholder placeholder, PlaceholderMetadata? metadata)
        {
            ArgumentNullException.ThrowIfNull(placeholder);
            if (!HasTmdbTitle(placeholder))
            {
                return For(placeholder, ListCollagePosterReadState.NotVerified, null);
            }

            if (metadata == null)
            {
                return For(placeholder, ListCollagePosterReadState.Unavailable, null);
            }

            if (metadata.SeasonReadFailed)
            {
                return For(placeholder, ListCollagePosterReadState.ReadFailed, null);
            }

            if (metadata.Partial)
            {
                return For(placeholder, ListCollagePosterReadState.Partial, null);
            }

            return ListRules.IsValidPosterPath(metadata.PosterPath)
                ? For(placeholder, ListCollagePosterReadState.Verified, metadata.PosterPath)
                : For(placeholder, ListCollagePosterReadState.KnownNoPoster, null);
        }

        /// <summary>
        /// Evidence from the TMDB poster read JE uses without Seerr (<see cref="ListMetadataService.ReadTmdbPosterAsync"/>):
        /// answered with a poster, answered without one, or not answered.
        /// </summary>
        /// <param name="placeholder">The placeholder the read was for.</param>
        /// <param name="poster">The poster path read.</param>
        /// <param name="answered">Whether TMDB answered for the title.</param>
        /// <returns>The evidence.</returns>
        public static ListCollagePosterEvidence FromTmdbRead(Placeholder placeholder, string? poster, bool answered)
        {
            ArgumentNullException.ThrowIfNull(placeholder);
            if (!HasTmdbTitle(placeholder))
            {
                return For(placeholder, ListCollagePosterReadState.NotVerified, null);
            }

            if (!answered)
            {
                return For(placeholder, ListCollagePosterReadState.ReadFailed, null);
            }

            return ListRules.IsValidPosterPath(poster)
                ? For(placeholder, ListCollagePosterReadState.Verified, poster)
                : For(placeholder, ListCollagePosterReadState.KnownNoPoster, null);
        }

        internal static bool HasTmdbTitle(Placeholder placeholder) =>
            placeholder.Kind != PlaceholderKinds.Custom && placeholder.TmdbId is > 0;

        private static ListCollagePosterEvidence For(Placeholder placeholder, ListCollagePosterReadState state, string? poster) =>
            new(placeholder.Id, placeholder.Kind, placeholder.TmdbId, placeholder.SeasonNumber, state, poster);
    }

    /// <summary>
    /// One viewer, as the privacy owner currently sees them: a real person (not an API key or device), the revision of
    /// the policy the verdicts come from (null when it couldn't be read), and an artwork verdict per placeholder.
    /// There is no admin shortcut: an administrator's own Hidden Content and Spoiler Guard verdicts apply like anyone's.
    /// </summary>
    /// <param name="UserId">The requesting person.</param>
    /// <param name="IsHuman">Whether the request is a person's session (false for an API key or unknown caller).</param>
    /// <param name="PolicyRevision">The current policy/settings revision the verdicts were made under, or null.</param>
    /// <param name="Verdicts">Artwork verdicts by placeholder id (a missing one is <see cref="ListCollageArtworkVerdict.Unknown"/>).</param>
    public sealed record ListCollageViewer(Guid UserId, bool IsHuman, string? PolicyRevision, IReadOnlyDictionary<string, ListCollageArtworkVerdict> Verdicts);

    /// <summary>The facts one viewer's poster selection is made from.</summary>
    /// <param name="ListKind">A <see cref="ListKinds"/> value.</param>
    /// <param name="Placeholders">The list's placeholders (document order).</param>
    /// <param name="Order">A playlist's canonical order tokens (ignored for a collection).</param>
    /// <param name="Evidence">The server's poster evidence.</param>
    /// <param name="Viewer">The one viewer.</param>
    /// <param name="SkipPosters">Poster paths whose bytes failed for good (not found, undecodable).</param>
    public sealed record ListCollageSelectionInput(
        string ListKind,
        IReadOnlyList<Placeholder> Placeholders,
        IReadOnlyList<string> Order,
        IReadOnlyList<ListCollagePosterEvidence> Evidence,
        ListCollageViewer Viewer,
        IReadOnlyCollection<string>? SkipPosters = null);

    /// <summary>A poster a viewer's collage may use.</summary>
    /// <param name="PlaceholderId">The placeholder it is for.</param>
    /// <param name="PosterPath">The server-verified poster path.</param>
    public sealed record ListCollageSelectedPoster(string PlaceholderId, string PosterPath);

    /// <summary>One viewer's selected posters.</summary>
    /// <param name="Status">The outcome.</param>
    /// <param name="Candidates">Allowed posters in list order (at most <see cref="ListCollagePosterSet.MaxCandidates"/>).</param>
    /// <param name="Checked">Placeholders looked at (at most <see cref="ListCollagePosterSet.MaxChecks"/>).</param>
    /// <param name="RetryWanted">Whether a left-out title may be allowed once its read or verdict answers.</param>
    /// <param name="Viewer">The viewer it was selected for.</param>
    /// <param name="PolicyRevision">The policy revision it was selected under.</param>
    /// <param name="SafeSetDigest">SHA-256 (hex) of the ordered candidates; empty when there are none.</param>
    public sealed record ListCollageSelection(
        ListCollageSelectionStatus Status,
        IReadOnlyList<ListCollageSelectedPoster> Candidates,
        int Checked,
        bool RetryWanted,
        Guid Viewer,
        string PolicyRevision,
        string SafeSetDigest);

    /// <summary>
    /// Selects the posters ONE viewer's collage may use: a playlist's canonical order (entries the order doesn't know yet
    /// last, in document order) or a collection's release order (TBA last, then title, then id); only server-verified
    /// posters for exactly that title; nothing the viewer's current verdicts don't allow; distinct posters; at most
    /// <see cref="MaxCandidates"/> accepted after at most <see cref="MaxChecks"/> placeholders. Anything unknown is left
    /// out, and an unknown viewer or policy selects nothing. Pure: the same input gives the same selection.
    /// </summary>
    public static class ListCollagePosterSet
    {
        /// <summary>Most posters accepted (the renderer uses the first four that decode).</summary>
        public const int MaxCandidates = 8;

        /// <summary>Most placeholders looked at per selection.</summary>
        public const int MaxChecks = 48;

        /// <summary>Selects one viewer's posters.</summary>
        /// <param name="input">The facts.</param>
        /// <returns>The selection.</returns>
        public static ListCollageSelection Select(ListCollageSelectionInput input)
        {
            ArgumentNullException.ThrowIfNull(input);
            var viewer = input.Viewer;
            ArgumentNullException.ThrowIfNull(viewer);
            var revision = viewer.PolicyRevision ?? string.Empty;
            if (viewer.UserId == Guid.Empty || !viewer.IsHuman || string.IsNullOrWhiteSpace(viewer.PolicyRevision) || viewer.Verdicts == null)
            {
                return None(ListCollageSelectionStatus.ViewerUnknown, viewer.UserId, revision);
            }

            if (ListCollageRenderer.ShapeFor(input.ListKind) == null)
            {
                return None(ListCollageSelectionStatus.Unsupported, viewer.UserId, revision);
            }

            // Evidence per placeholder; two pieces for one placeholder are ambiguous, so neither counts.
            var evidence = new Dictionary<string, ListCollagePosterEvidence?>(StringComparer.Ordinal);
            foreach (var item in input.Evidence ?? Array.Empty<ListCollagePosterEvidence>())
            {
                if (item?.PlaceholderId == null)
                {
                    continue;
                }

                evidence[item.PlaceholderId] = evidence.ContainsKey(item.PlaceholderId) ? null : item;
            }

            var skip = input.SkipPosters ?? Array.Empty<string>();
            var accepted = new List<ListCollageSelectedPoster>(MaxCandidates);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var retry = false;
            var checkedCount = 0;
            foreach (var placeholder in Ordered(input))
            {
                if (accepted.Count == MaxCandidates || checkedCount == MaxChecks)
                {
                    break;
                }

                checkedCount++;
                if (!ListCollagePosterEvidence.HasTmdbTitle(placeholder))
                {
                    continue;
                }

                evidence.TryGetValue(placeholder.Id, out var read);
                if (read == null)
                {
                    retry = true;
                    continue;
                }

                switch (read.State)
                {
                    case ListCollagePosterReadState.Verified:
                        break;
                    case ListCollagePosterReadState.KnownNoPoster:
                        continue;
                    default:
                        retry = true;
                        continue;
                }

                if (!SameTitle(placeholder, read) || !ListRules.IsValidPosterPath(read.ServerPosterPath))
                {
                    continue;
                }

                var verdict = viewer.Verdicts.TryGetValue(placeholder.Id, out var v) ? v : ListCollageArtworkVerdict.Unknown;
                if (verdict != ListCollageArtworkVerdict.Allowed)
                {
                    retry |= verdict == ListCollageArtworkVerdict.Unknown;
                    continue;
                }

                var poster = read.ServerPosterPath!;
                if (skip.Contains(poster) || !seen.Add(poster))
                {
                    continue;
                }

                accepted.Add(new ListCollageSelectedPoster(placeholder.Id, poster));
            }

            return new ListCollageSelection(
                accepted.Count == 0 ? ListCollageSelectionStatus.Empty : ListCollageSelectionStatus.Selected,
                accepted,
                checkedCount,
                retry,
                viewer.UserId,
                revision,
                accepted.Count == 0 ? string.Empty : Digest(accepted));
        }

        private static ListCollageSelection None(ListCollageSelectionStatus status, Guid viewer, string revision) =>
            new(status, Array.Empty<ListCollageSelectedPoster>(), 0, false, viewer, revision, string.Empty);

        private static bool SameTitle(Placeholder placeholder, ListCollagePosterEvidence read) =>
            string.Equals(read.Kind, placeholder.Kind, StringComparison.Ordinal)
            && read.TmdbId == placeholder.TmdbId
            && read.SeasonNumber == placeholder.SeasonNumber;

        private static IEnumerable<Placeholder> Ordered(ListCollageSelectionInput input)
        {
            var placeholders = (input.Placeholders ?? Array.Empty<Placeholder>()).Where(p => p?.Id != null).ToList();
            if (input.ListKind != ListKinds.Playlist)
            {
                return ListOrder.SortForCollection(placeholders);
            }

            var byId = new Dictionary<string, Placeholder>(StringComparer.Ordinal);
            foreach (var item in placeholders)
            {
                byId.TryAdd(item.Id, item);
            }

            var ordered = new List<Placeholder>(placeholders.Count);
            foreach (var token in input.Order ?? Array.Empty<string>())
            {
                var id = ListOrder.PlaceholderIdOf(token);
                if (id != null && byId.Remove(id, out var placeholder))
                {
                    ordered.Add(placeholder);
                }
            }

            // Entries the order doesn't mention yet (reconciled on the next view) go last, in document order.
            ordered.AddRange(placeholders.Where(p => byId.Remove(p.Id)));
            return ordered;
        }

        private static string Digest(IReadOnlyList<ListCollageSelectedPoster> posters)
        {
            var text = new StringBuilder("je-list-collage-safe-set/1\n");
            foreach (var poster in posters)
            {
                text.Append(poster.PlaceholderId).Append('\t').Append(poster.PosterPath).Append('\n');
            }

            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString()))).ToLowerInvariant();
        }
    }

    /// <summary>
    /// The identity of rendered collage BYTES: the exact ordered content of the posters drawn, the shape, the renderer
    /// version and the output transform. It has no viewer, list or permission in it: the same safe posters give the same
    /// bytes for anyone, and holding a cached copy never says who may receive it (see <see cref="ListCollageGrantIdentity"/>).
    /// </summary>
    /// <param name="Value">SHA-256 (lowercase hex) of <see cref="Canonical"/>.</param>
    public readonly record struct ListCollageByteKey(string Value)
    {
        private static readonly Regex TransformPattern = new("^[a-z0-9=.,x-]{1,64}$", RegexOptions.CultureInvariant);

        /// <summary>The key of a rendering.</summary>
        /// <param name="shape">The shape drawn.</param>
        /// <param name="usedPosters">The poster bytes drawn, in cell order (1-4).</param>
        /// <param name="transform">The output transform (e.g. <c>original</c>, <c>w=300</c>).</param>
        /// <returns>The key.</returns>
        public static ListCollageByteKey Compute(ListCollageShape shape, IReadOnlyList<byte[]> usedPosters, string transform) =>
            new(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(shape, usedPosters, transform)))).ToLowerInvariant());

        /// <summary>The canonical text the key hashes.</summary>
        /// <param name="shape">The shape drawn.</param>
        /// <param name="usedPosters">The poster bytes drawn, in cell order (1-4).</param>
        /// <param name="transform">The output transform.</param>
        /// <returns>The text.</returns>
        public static string Canonical(ListCollageShape shape, IReadOnlyList<byte[]> usedPosters, string transform)
        {
            ArgumentNullException.ThrowIfNull(usedPosters);
            if (usedPosters.Count is < 1 or > ListCollageRenderer.MaxPosters || usedPosters.Any(p => p == null || p.Length == 0))
            {
                throw new ArgumentException("A collage is drawn from one to four posters.", nameof(usedPosters));
            }

            if (transform == null || !TransformPattern.IsMatch(transform))
            {
                throw new ArgumentException("Unknown transform.", nameof(transform));
            }

            var (width, height) = ListCollageRenderer.SizeFor(shape);
            var text = new StringBuilder("je-list-collage-bytes/1\n");
            text.Append("renderer=").Append(ListCollageRenderer.Version).Append('\n');
            text.Append("shape=").Append(shape == ListCollageShape.Square ? "square" : "poster").Append('\n');
            text.Append("size=").Append(width.ToString(CultureInfo.InvariantCulture)).Append('x').Append(height.ToString(CultureInfo.InvariantCulture)).Append('\n');
            text.Append("quality=").Append(ListCollageRenderer.JpegQuality.ToString(CultureInfo.InvariantCulture)).Append('\n');
            text.Append("transform=").Append(transform).Append('\n');
            text.Append("posters=").Append(usedPosters.Count.ToString(CultureInfo.InvariantCulture)).Append('\n');
            foreach (var poster in usedPosters)
            {
                text.Append(Convert.ToHexString(SHA256.HashData(poster)).ToLowerInvariant()).Append('\n');
            }

            return text.ToString();
        }
    }

    /// <summary>
    /// The proposed identity of ONE viewer's permission to receive a collage (input to a future grant/tag owner): the
    /// server, the list and its native incarnation, the viewer, and the current revisions of their policy, the settings,
    /// the consent, the raw membership, the restore generation and their safe poster set. Distinct viewers always get
    /// distinct identities, even for identical bytes. It is not a tag, ETag or cache key and mints nothing.
    /// </summary>
    /// <param name="ServerId">The server/installation signing identity.</param>
    /// <param name="ListId">The real list id.</param>
    /// <param name="ListIncarnation">The list's proven native incarnation.</param>
    /// <param name="Viewer">The requesting person.</param>
    /// <param name="PolicyRevision">Their current policy revision.</param>
    /// <param name="SettingsRevision">The current admin/personal settings revision.</param>
    /// <param name="ConsentRevision">The current consent (principal and revision).</param>
    /// <param name="MembershipRevision">The current raw membership revision.</param>
    /// <param name="RestoreGeneration">The current restore generation.</param>
    /// <param name="SafeSetDigest">The viewer's <see cref="ListCollageSelection.SafeSetDigest"/>.</param>
    /// <param name="GrantVersion">The grant format version (1 or more).</param>
    public sealed record ListCollageGrantIdentity(
        string ServerId,
        Guid ListId,
        string ListIncarnation,
        Guid Viewer,
        string PolicyRevision,
        string SettingsRevision,
        string ConsentRevision,
        string MembershipRevision,
        string RestoreGeneration,
        string SafeSetDigest,
        int GrantVersion)
    {
        /// <summary>SHA-256 (lowercase hex) of every field; refuses when any authority input is missing.</summary>
        /// <returns>The digest.</returns>
        public string Digest()
        {
            var text = new[] { ServerId, ListIncarnation, PolicyRevision, SettingsRevision, ConsentRevision, MembershipRevision, RestoreGeneration, SafeSetDigest };
            if (ListId == Guid.Empty || Viewer == Guid.Empty || GrantVersion < 1 || text.Any(string.IsNullOrWhiteSpace))
            {
                throw new InvalidOperationException("A collage grant needs every authority input.");
            }

            var canonical = new StringBuilder("je-list-collage-grant/").Append(GrantVersion.ToString(CultureInfo.InvariantCulture)).Append('\n');
            foreach (var (name, value) in new (string, string)[]
                     {
                         ("server", ServerId), ("list", ListId.ToString("N")), ("incarnation", ListIncarnation), ("viewer", Viewer.ToString("N")),
                         ("policy", PolicyRevision), ("settings", SettingsRevision), ("consent", ConsentRevision), ("membership", MembershipRevision),
                         ("restore", RestoreGeneration), ("safe-set", SafeSetDigest),
                     })
            {
                // Length-prefixed so no value can shift into the next field.
                canonical.Append(name).Append('=').Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value).Append('\n');
            }

            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString()))).ToLowerInvariant();
        }
    }
}

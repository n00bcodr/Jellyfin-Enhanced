using System;
using System.Collections.Generic;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>
    /// Per-response state for stamping native poster tag variant tokens, created by
    /// <see cref="NativePosterTagStamper.Begin"/> only when the response qualifies.
    /// </summary>
    public sealed class NativePosterTagStampSession
    {
        internal NativePosterTagStampSession(JUser user, PosterTagSettings settings, string marker, UserSpoilerBlur? spoilerState)
        {
            User = user;
            Settings = settings;
            Marker = marker;
            SpoilerState = spoilerState;
        }

        internal JUser User { get; }

        internal PosterTagSettings Settings { get; }

        internal string Marker { get; }

        internal UserSpoilerBlur? SpoilerState { get; }

        // Image owners looked up during this response (ParentPrimaryImageItemId).
        internal Dictionary<Guid, (string? Type, string? SeriesIdN)> Owners { get; } = new();
    }

    // Metadata-time half of native poster tags, called from
    // SpoilerIdentityTagFilter after an authenticated item response was built.
    // For native clients (NativeClientPolicy) of users with the feature on, it
    // rewrites the Primary image tags a poster can be drawn from:
    //
    //   ImageTags[Primary]      owner = the item itself
    //   SeriesPrimaryImageTag   owner = SeriesId
    //   ParentPrimaryImageTag   owner = ParentPrimaryImageItemId
    //   SearchHint.PrimaryImageTag  owner = the hint's item
    //
    // to "[sb-…-]{tag}-jet{token}-jeu{marker}" (ImageTagDecoration), re-keying
    // the matching ImageBlurHashes entries, because clients look blurhashes up
    // by the tag string they hold. Only DTOs of the web's card types are
    // touched (Movie, Series, Season, Episode, BoxSet, Video), and only owners
    // of those types, so with Spoiler Guard off no other image URL changes.
    public sealed class NativePosterTagStamper
    {
        private static readonly HashSet<BaseItemKind> CardTypes = new(TagCacheService.TaggableTypes);

        private readonly NativeClientPolicy _clientPolicy;
        private readonly PosterTagSettingsProvider _settings;
        private readonly PosterTagVariantToken _tokens;
        private readonly PosterTagDataProvider _data;
        private readonly SpoilerIdentityService _identity;
        private readonly SpoilerUserResolver _spoilerResolver;
        private readonly SpoilerTagDataStripper _stripper;
        private readonly PosterTagUserCache _users;
        private readonly ILibraryManager _libraryManager;

        public NativePosterTagStamper(
            NativeClientPolicy clientPolicy,
            PosterTagSettingsProvider settings,
            PosterTagVariantToken tokens,
            PosterTagDataProvider data,
            SpoilerIdentityService identity,
            SpoilerUserResolver spoilerResolver,
            SpoilerTagDataStripper stripper,
            PosterTagUserCache users,
            ILibraryManager libraryManager)
        {
            _clientPolicy = clientPolicy;
            _settings = settings;
            _tokens = tokens;
            _data = data;
            _identity = identity;
            _spoilerResolver = spoilerResolver;
            _stripper = stripper;
            _users = users;
            _libraryManager = libraryManager;
        }

        /// <summary>
        /// Cheap pre-check before the action runs: the master switch is on and the client is a native one.
        /// No I/O.
        /// </summary>
        public bool IsCandidate(HttpContext httpContext)
            => JellyfinEnhanced.Instance?.Configuration?.NativePosterTagsEnabled == true
                && _clientPolicy.IsNativeClient(httpContext.User);

        /// <summary>
        /// Starts stamping one response, or null when the user's native poster tags are off or no tag group
        /// is enabled (their image tags then stay untouched).
        /// </summary>
        public NativePosterTagStampSession? Begin(HttpContext httpContext, Guid userId)
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.NativePosterTagsEnabled != true || !_clientPolicy.IsNativeClient(httpContext.User)) return null;
            var settings = _settings.Get(userId);
            if (!settings.NativeEnabled || !settings.AnyGroupEnabled) return null;
            var user = _users.Get(userId);
            if (user == null) return null;
            var spoilerState = cfg.SpoilerBlurEnabled ? _spoilerResolver.LoadUserState(httpContext, userId) : null;
            return new NativePosterTagStampSession(user, settings, _identity.MintMarker(userId), spoilerState);
        }

        /// <summary>Stamps the eligible Primary image tags of one item DTO.</summary>
        public void StampItem(BaseItemDto dto, NativePosterTagStampSession session)
        {
            if (dto == null || !CardTypes.Contains(dto.Type)) return;

            // The card the client draws shows its OWN indicator (played check,
            // unplayed count) whichever image it uses, so the offset bit comes
            // from this DTO's user data for every field.
            var topRight = dto.UserData != null
                && (dto.UserData.Played || dto.UserData.UnplayedItemCount > 0);

            if (dto.ImageTags != null && dto.ImageTags.TryGetValue(ImageType.Primary, out var primary) && !string.IsNullOrEmpty(primary))
            {
                var seriesIdN = dto.Type is BaseItemKind.Episode or BaseItemKind.Season && dto.SeriesId is { } sid && sid != Guid.Empty
                    ? sid.ToString("N")
                    : null;
                var stamped = StampField(dto, primary, dto.Id, dto.Type.ToString(), seriesIdN, topRight, session);
                if (!ReferenceEquals(stamped, primary)) dto.ImageTags[ImageType.Primary] = stamped;
            }

            if (!string.IsNullOrEmpty(dto.SeriesPrimaryImageTag) && dto.SeriesId is { } seriesId && seriesId != Guid.Empty)
            {
                dto.SeriesPrimaryImageTag = StampField(dto, dto.SeriesPrimaryImageTag, seriesId, nameof(BaseItemKind.Series), null, topRight, session);
            }

            if (!string.IsNullOrEmpty(dto.ParentPrimaryImageTag)
                && TryParseOwnerId(dto.ParentPrimaryImageItemId, out var parentId)
                && GetOwner(parentId, session) is { Type: { } parentType } owner)
            {
                dto.ParentPrimaryImageTag = StampField(dto, dto.ParentPrimaryImageTag, parentId, parentType, owner.SeriesIdN, topRight, session);
            }
        }

        /// <summary>Stamps a search hint's Primary image tag.</summary>
        public void StampSearchHint(SearchHint hint, NativePosterTagStampSession session)
        {
            if (hint == null || string.IsNullOrEmpty(hint.PrimaryImageTag) || !CardTypes.Contains(hint.Type)) return;
            var ownerId = hint.Id;
            if (ownerId == Guid.Empty) return;
            var owner = GetOwner(ownerId, session);
            hint.PrimaryImageTag = StampField(null, hint.PrimaryImageTag, ownerId, hint.Type.ToString(), owner.SeriesIdN, false, session);
        }

        private string StampField(BaseItemDto? dto, string tag, Guid ownerId, string ownerType, string? ownerSeriesIdN, bool topRight, NativePosterTagStampSession session)
        {
            // Idempotent: a filter re-entry must not re-mint.
            if (ImageTagDecoration.GetVariant(tag) != null) return tag;

            var flags = topRight ? PosterTagVariantFlags.TopRightOffset : PosterTagVariantFlags.None;
            // Same "guarded kind" rule the tag strip uses (SpoilerTagDataStripper).
            if (session.SpoilerState != null && _stripper.IsGuarded(session.SpoilerState, ownerId, ownerType, ownerSeriesIdN))
            {
                flags |= PosterTagVariantFlags.SpoilerScoped;
            }

            var token = _tokens.Mint(
                session.User.Id,
                ownerId,
                session.Settings.Digest,
                PosterTagComposer.PixelVersion,
                flags,
                _data.GetPinnedDataHash(ownerId, session.User));
            var stamped = ImageTagDecoration.WithVariant(tag, token, session.Marker);
            if (dto != null && !ReferenceEquals(stamped, tag)) ReKeyPrimaryBlurhash(dto, tag, stamped);
            return stamped;
        }

        // Owner type for an image owner we only know by id: the tag cache entry
        // when there is one (entries exist only for card types), else the
        // library item. Memoized per response.
        private (string? Type, string? SeriesIdN) GetOwner(Guid ownerId, NativePosterTagStampSession session)
        {
            if (session.Owners.TryGetValue(ownerId, out var known)) return known;
            (string? Type, string? SeriesIdN) owner = (null, null);
            if (_data.TryGetCachedEntry(ownerId, out var entry))
            {
                owner = (entry.Type, entry.SeriesId);
            }
            else if (_libraryManager.GetItemById(ownerId) is BaseItem item && CardTypes.Contains(item.GetBaseItemKind()))
            {
                var seriesId = item switch
                {
                    Episode episode => episode.SeriesId,
                    Season season => season.SeriesId,
                    _ => Guid.Empty,
                };
                owner = (item.GetBaseItemKind().ToString(), seriesId == Guid.Empty ? null : seriesId.ToString("N"));
            }

            session.Owners[ownerId] = owner;
            return owner;
        }

        private static bool TryParseOwnerId(object? value, out Guid id)
        {
            switch (value)
            {
                case Guid g when g != Guid.Empty:
                    id = g;
                    return true;
                case string s when Guid.TryParse(s, out var parsed) && parsed != Guid.Empty:
                    id = parsed;
                    return true;
                default:
                    id = Guid.Empty;
                    return false;
            }
        }

        // ImageBlurHashes[Primary] is keyed by the tag string the client holds
        // (own, series and parent Primary tags share it). The old key may still
        // be the undecorated tag (the strip filter's "sb-" prefix never re-keys),
        // so fall back to the cache-bust-stripped and fully stripped forms.
        private static void ReKeyPrimaryBlurhash(BaseItemDto dto, string oldTag, string newTag)
        {
            if (dto.ImageBlurHashes == null) return;
            if (!dto.ImageBlurHashes.TryGetValue(ImageType.Primary, out var byTag) || byTag == null) return;
            if (byTag.Remove(oldTag, out var hash))
            {
                byTag[newTag] = hash;
                return;
            }

            var parts = ImageTagDecoration.Parse(oldTag);
            var withoutCacheBust = ImageTagDecoration.Compose(parts with { CacheBust = null });
            if (byTag.Remove(withoutCacheBust, out hash) || byTag.Remove(parts.Base, out hash))
            {
                byTag[newTag] = hash;
            }
        }
    }
}

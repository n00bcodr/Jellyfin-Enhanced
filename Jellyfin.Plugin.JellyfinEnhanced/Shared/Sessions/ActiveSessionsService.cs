using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Session;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Sessions
{
    /// <summary>
    /// The active-streams session list, shared by GET active-streams/sessions (Chrome) and the bootstrap payload
    /// (Platform). Moved verbatim from the controller in restructure S2.6. It never reads the request's user: the
    /// caller passes <c>isAdmin</c> after applying its own access gate.
    /// </summary>
    public class ActiveSessionsService
    {
        private readonly ISessionManager _sessionManager;

        public ActiveSessionsService(ISessionManager sessionManager)
        {
            _sessionManager = sessionManager;
        }

        /// <summary>
        /// The now-playing sessions as GET active-streams/sessions returns them
        /// (client IPs only for admins). Callers apply the access gate first.
        /// </summary>
        public List<object> BuildActiveSessionList(bool isAdmin)
        {
            var sessions = _sessionManager.Sessions
                .Where(s => s.NowPlayingItem != null)
                .Select(s => new
                {
                    UserId = s.UserId,
                    UserName = s.UserName,
                    UserHasPrimaryImage = s.UserPrimaryImageTag != null,
                    Client = s.Client,
                    DeviceName = s.DeviceName,
                    // IP only for admins
                    RemoteEndPoint = isAdmin ? s.RemoteEndPoint : null,
                    LastActivityDate = s.LastActivityDate,
                    NowPlayingItem = s.NowPlayingItem == null ? null : new
                    {
                        Id = s.NowPlayingItem.Id.ToString("N"),
                        Type = s.NowPlayingItem.Type.ToString(),
                        s.NowPlayingItem.Name,
                        s.NowPlayingItem.SeriesName,
                        s.NowPlayingItem.RunTimeTicks,
                        s.NowPlayingItem.ProductionYear,
                        ParentIndexNumber = s.NowPlayingItem.ParentIndexNumber,
                        IndexNumber = s.NowPlayingItem.IndexNumber,
                        ImageTags = s.NowPlayingItem.ImageTags != null
                            ? s.NowPlayingItem.ImageTags.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value)
                            : null,
                        SeriesId = s.NowPlayingItem.SeriesId?.ToString("N"),
                        SeriesPrimaryImageTag = s.NowPlayingItem.SeriesPrimaryImageTag,
                        // Materialized here (not during serialization) so a failure
                    // surfaces to the caller's try/catch.
                    MediaStreams = s.NowPlayingItem.MediaStreams?.Select(ms => new
                        {
                            ms.Type,
                            ms.Codec,
                            ms.BitRate
                        }).ToList()
                    },
                    PlayState = s.PlayState == null ? null : new
                    {
                        s.PlayState.IsPaused,
                        s.PlayState.PositionTicks,
                        s.PlayState.PlayMethod
                    },
                    TranscodingInfo = s.TranscodingInfo == null ? null : new
                    {
                        s.TranscodingInfo.IsVideoDirect,
                        s.TranscodingInfo.VideoCodec,
                        s.TranscodingInfo.AudioCodec,
                        s.TranscodingInfo.Bitrate,
                        s.TranscodingInfo.TranscodeReasons,
                        s.TranscodingInfo.CompletionPercentage,
                        s.TranscodingInfo.Width,
                        s.TranscodingInfo.Height,
                        s.TranscodingInfo.Framerate
                    }
                });

            return sessions.ToList<object>();
        }
    }
}

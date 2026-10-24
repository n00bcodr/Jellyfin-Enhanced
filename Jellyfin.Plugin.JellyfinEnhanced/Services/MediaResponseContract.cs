using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The host's raw playback responses, selected before any resource projection replaces the transport. These actions
/// return media bytes or transport playlists, never title DTOs, artwork or evidence-derived answers. Everything else
/// retains the privacy commit owner, including unknown actions and responses declaring a binary content type.
/// </summary>
internal static class MediaResponseContract
{
    // Keep this narrow contract in step with the pinned host's ProducesAudioFile/VideoFile/PlaylistFile annotations
    // and the three subtitle file actions. MediaResponseContractArchitectureTests checks both directions against the
    // actual host assembly and rejects overlaps with the privacy surface registry. No content sniffing or MIME override.
    internal static bool Streams(ActionDescriptor descriptor)
    {
        if (descriptor is not ControllerActionDescriptor action
            || action.ControllerTypeInfo?.Assembly.GetName().Name != "Jellyfin.Api"
            || action.ControllerTypeInfo.FullName != "Jellyfin.Api.Controllers." + action.ControllerName + "Controller"
            || action.MethodInfo?.DeclaringType != action.ControllerTypeInfo.AsType()
            || action.MethodInfo.Name != action.ActionName)
            return false;

        return action.ControllerName switch
        {
            "Audio" => action.ActionName is "GetAudioStream" or "GetAudioStreamByContainer",
            "Videos" => action.ActionName is "GetVideoStream" or "GetVideoStreamByContainer",
            "UniversalAudio" => action.ActionName == "GetUniversalAudioStream",
            "DynamicHls" => action.ActionName is "GetLiveHlsStream" or "GetMasterHlsVideoPlaylist" or "GetMasterHlsAudioPlaylist"
                or "GetVariantHlsVideoPlaylist" or "GetVariantHlsAudioPlaylist" or "GetHlsVideoSegment" or "GetHlsAudioSegment",
            "HlsSegment" => action.ActionName is "GetHlsAudioSegmentLegacy" or "GetHlsPlaylistLegacy" or "GetHlsVideoSegmentLegacy",
            "LiveTv" => action.ActionName is "GetLiveRecordingFile" or "GetLiveStreamFile",
            "Subtitle" => action.ActionName is "GetRemoteSubtitles" or "GetSubtitle" or "GetSubtitleWithTicks" or "GetSubtitlePlaylist",
            _ => false,
        };
    }
}

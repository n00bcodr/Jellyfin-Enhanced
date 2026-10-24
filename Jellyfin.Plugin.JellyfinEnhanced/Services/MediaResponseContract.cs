using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The host's raw playback responses, selected before any resource projection replaces the transport. These actions
/// return media bytes or title-free transport playlists, never generated masters, artwork or evidence-derived answers. Everything else
/// retains the privacy commit owner, including unknown actions and responses declaring a binary content type.
/// </summary>
internal static class MediaResponseContract
{
    // Annotations locate candidates, not proof: master playlists carry subtitle DisplayTitle and stay owned.
    // MediaResponseContractArchitectureTests also inspects the pinned generator and the mixed download contract.
    private static bool HostAction(ActionDescriptor descriptor, out ControllerActionDescriptor action)
    {
        action = descriptor as ControllerActionDescriptor ?? null!;
        if (action == null
            || action.ControllerTypeInfo?.Assembly.GetName().Name != "Jellyfin.Api"
            || action.ControllerTypeInfo.FullName != "Jellyfin.Api.Controllers." + action.ControllerName + "Controller"
            || action.MethodInfo?.DeclaringType != action.ControllerTypeInfo.AsType()
            || action.MethodInfo.Name != action.ActionName)
            return false;

        return true;
    }

    internal static bool MasterPlaylist(ActionDescriptor descriptor) => HostAction(descriptor, out var action)
        && action.ControllerName == "DynamicHls" && action.ActionName is "GetMasterHlsVideoPlaylist" or "GetMasterHlsAudioPlaylist";

    internal static bool Download(ActionDescriptor descriptor) => HostAction(descriptor, out var action)
        && action.ControllerName == "Library" && action.ActionName is "GetDownload" or "GetFile";

    // This mixed route is owned until its final executor is known. A MIME declaration alone grants nothing:
    // require a range-enabled physical audio/video file for the same native library entity and path.
    internal static bool RawDownload(ActionContext context, IActionResult result)
    {
        if (!Download(context.ActionDescriptor) || result is not PhysicalFileResult { EnableRangeProcessing: true } file
            || !Guid.TryParse(context.RouteData.Values["itemId"]?.ToString(), out var id)
            || context.HttpContext.RequestServices.GetService<ILibraryManager>()?.GetItemById(id) is not { } item
            || item is not (Video or Audio) || string.IsNullOrEmpty(item.Path)) return false;
        var path = item.Path;
        // GetDownload resolves symlinks before selecting the physical-file executor.
        if (System.IO.File.ResolveLinkTarget(path, true) is { } target) path = target.FullName;
        var mime = MediaBrowser.Model.Net.MimeTypes.GetMimeType(path);
        return string.Equals(System.IO.Path.GetFullPath(path), file.FileName, StringComparison.Ordinal)
            && string.Equals(mime, file.ContentType, StringComparison.OrdinalIgnoreCase)
            && (file.ContentType.StartsWith("video/", StringComparison.OrdinalIgnoreCase)
                || file.ContentType.StartsWith("audio/", StringComparison.OrdinalIgnoreCase));
    }

    internal static bool Streams(ActionDescriptor descriptor)
    {
        if (!HostAction(descriptor, out var action)) return false;

        return action.ControllerName switch
        {
            "Audio" => action.ActionName is "GetAudioStream" or "GetAudioStreamByContainer",
            "Videos" => action.ActionName is "GetVideoStream" or "GetVideoStreamByContainer",
            "UniversalAudio" => action.ActionName == "GetUniversalAudioStream",
            "DynamicHls" => action.ActionName is "GetLiveHlsStream"
                or "GetVariantHlsVideoPlaylist" or "GetVariantHlsAudioPlaylist" or "GetHlsVideoSegment" or "GetHlsAudioSegment",
            "HlsSegment" => action.ActionName is "GetHlsAudioSegmentLegacy" or "GetHlsPlaylistLegacy" or "GetHlsVideoSegmentLegacy",
            "LiveTv" => action.ActionName is "GetLiveRecordingFile" or "GetLiveStreamFile",
            "Subtitle" => action.ActionName is "GetRemoteSubtitles" or "GetSubtitle" or "GetSubtitleWithTicks" or "GetSubtitlePlaylist",
            _ => false,
        };
    }
}

/// <summary>The pinned host's generated master text, projected before its file executor can write any bytes.</summary>
internal static class GeneratedPlaylistPrivacy
{
    internal static byte[]? Project(byte[] contents, bool titleFamily, bool images)
    {
        if (titleFamily && images) return contents;
        var text = new System.Text.UTF8Encoding(false, true).GetString(contents);
        var output = new System.Text.StringBuilder();
        var track = 0;
        var lines = text.Split('\n');
        for (var index = 0; index < lines.Length; index++)
        {
            var raw = lines[index];
            var line = raw.TrimEnd('\r');
            if (!images && (line.StartsWith("#EXT-X-IMAGE-", StringComparison.Ordinal)
                || line.StartsWith("#EXT-X-I-FRAME-", StringComparison.Ordinal))) continue;
            if (!titleFamily && line.StartsWith("#EXT-X-MEDIA:", StringComparison.Ordinal))
            {
                // Jellyfin writes free-form titles without HLS quoting. Reject malformed/injected lines rather than
                // trying to redact an unparseable document. Preserve transport choices/URLs, rebuild only the labels.
                var match = System.Text.RegularExpressions.Regex.Match(line,
                    "^#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"[^\"\\r\\n]*\",DEFAULT=(YES|NO),FORCED=(YES|NO),AUTOSELECT=YES,URI=\"([^\"\\r\\n]*)\",LANGUAGE=\"[^\"\\r\\n]*\"$");
                if (!match.Success) return null;
                line = FormattableString.Invariant($"#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"Subtitle {++track}\",DEFAULT={match.Groups[1].Value},FORCED={match.Groups[2].Value},AUTOSELECT=YES,URI=\"{match.Groups[3].Value}\",LANGUAGE=\"und\"");
            }
            // No other pinned master tag contains free-form title text. A future generator needs a fresh audit.
            if (!titleFamily && line.StartsWith('#') && line != "#EXTM3U"
                && !line.StartsWith("#EXT-X-MEDIA:", StringComparison.Ordinal)
                && !line.StartsWith("#EXT-X-STREAM-INF:", StringComparison.Ordinal)) return null;
            output.Append(line);
            if (index < lines.Length - 1) output.Append('\n');
        }
        return System.Text.Encoding.UTF8.GetBytes(output.ToString());
    }
}

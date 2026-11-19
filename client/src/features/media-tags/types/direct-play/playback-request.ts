// Direct play's PlaybackInfo request and the TranscodeReasons it reads, moved out of tag-direct-play.ts (which is at
// its size cap) when upstream abcaa16d grew it.
import { apiClient } from '../../host';

/** TranscodeReasons → tooltip phrase key (and the media fact it names). */
export const REASONS: Readonly<Record<string, readonly [string, ('container' | 'video' | 'audio')?]>> = {
    ContainerNotSupported: ['status_tag_dp_reason_container', 'container'],
    VideoCodecNotSupported: ['status_tag_dp_reason_video_codec', 'video'],
    VideoCodecTagNotSupported: ['status_tag_dp_reason_video_codec', 'video'],
    AudioCodecNotSupported: ['status_tag_dp_reason_audio_codec', 'audio'],
    ContainerBitrateExceedsLimit: ['status_tag_dp_reason_bitrate'],
    VideoBitrateNotSupported: ['status_tag_dp_reason_bitrate'],
    AudioBitrateNotSupported: ['status_tag_dp_reason_bitrate'],
    SubtitleCodecNotSupported: ['status_tag_dp_reason_subtitles'],
    VideoRangeTypeNotSupported: ['status_tag_dp_reason_range'],
    VideoProfileNotSupported: ['status_tag_dp_reason_video_format'],
    VideoLevelNotSupported: ['status_tag_dp_reason_video_format'],
    VideoResolutionNotSupported: ['status_tag_dp_reason_video_format'],
    VideoBitDepthNotSupported: ['status_tag_dp_reason_video_format'],
    VideoFramerateNotSupported: ['status_tag_dp_reason_video_format'],
    RefFramesNotSupported: ['status_tag_dp_reason_video_format'],
    AnamorphicVideoNotSupported: ['status_tag_dp_reason_video_format'],
    InterlacedVideoNotSupported: ['status_tag_dp_reason_video_format'],
    AudioChannelsNotSupported: ['status_tag_dp_reason_audio_format'],
    AudioProfileNotSupported: ['status_tag_dp_reason_audio_format'],
    AudioSampleRateNotSupported: ['status_tag_dp_reason_audio_format'],
    AudioBitDepthNotSupported: ['status_tag_dp_reason_audio_format'],
    SecondaryAudioNotSupported: ['status_tag_dp_reason_audio_format'],
};

/**
 * The headers of a JSON POST as ApiClient sends it: its own Authorization
 * (setRequestHeaders: client, device, device id, version and token, so
 * the server sees the request from this browser's session and device),
 * or the same composed from its accessors where it has no such method.
 * */
function requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const client = apiClient();
    if (typeof client.setRequestHeaders === 'function') {
        // ApiClient's own writer decides: when it sets no Authorization (not signed in),
        // the request goes without one, as ApiClient.ajax would send it.
        client.setRequestHeaders(headers);
        return headers;
    }
    const fields = [['Client', apiClient().appName?.()], ['Device', apiClient().deviceName?.()], ['DeviceId', apiClient().deviceId?.()], ['Version', apiClient().appVersion?.()], ['Token', apiClient().accessToken?.()]]
        .filter(([, value]) => value).map(([name, value]) => `${name}="${value}"`);
    if (fields.length) headers.Authorization = `MediaBrowser ${fields.join(', ')}`;
    return headers;
}

/**
 * POST one PlaybackInfo request with a deadline. apiClient().ajax takes no
 * abort signal and sets no timeout on a POST, so this is fetch with
 * ApiClient's own headers (requestHeaders) and an AbortController. Past
 * the deadline the request (or the read of its answer) is aborted and this
 * rejects at once, so the slot frees even if the request never settles;
 * an answer arriving after that is ignored.
 * @param body - JSON.
 * @returns The PlaybackInfoResponse; rejects on failure (`timedOut` set when the deadline passed).
 */
export function askPlaybackInfo(deadlineMs: number, url: string, body: string): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(Object.assign(new Error('PlaybackInfo timed out'), { timedOut: true }));
        }, deadlineMs);
    });
    const work = (async (): Promise<unknown> => {
        const response = await fetch(url, { method: 'POST', headers: requestHeaders(), body, signal: controller.signal });
        if (!response.ok) throw new Error(`PlaybackInfo answered ${response.status}`);
        return response.json();
    })();
    work.catch(() => { /* settled after the deadline: ignored */ });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

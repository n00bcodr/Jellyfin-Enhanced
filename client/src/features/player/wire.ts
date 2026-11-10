/** Untrusted Jellyfin 12 wire values are projected into this player's narrow view. */
export function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
const text = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const number = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s: unknown): s is string => typeof s === 'string') : [];
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export interface Stream { Type?: string | undefined; Index?: number | undefined; ReferenceFrameRate?: number | string | undefined; RealFrameRate?: number | string | undefined; AverageFrameRate?: number | string | undefined; DisplayTitle?: string | undefined; Title?: string | undefined; Language?: string | undefined; Codec?: string | undefined }
function stream(v: unknown): Stream {
    const r = record(v);
    const fps = (v: unknown) => typeof v === 'string' ? v : number(v);
    return { Type: text(r.Type), Index: number(r.Index), ReferenceFrameRate: fps(r.ReferenceFrameRate), RealFrameRate: fps(r.RealFrameRate), AverageFrameRate: fps(r.AverageFrameRate), DisplayTitle: text(r.DisplayTitle), Title: text(r.Title), Language: text(r.Language), Codec: text(r.Codec) };
}
export interface Item {
    Id?: string | undefined; Type?: string | undefined; SeriesId?: string | undefined; ParentId?: string | undefined; RunTimeTicks?: number | undefined; ProductionYear?: number | undefined;
    CommunityRating?: number | undefined; CriticRating?: number | undefined; OfficialRating?: string | undefined; Overview?: string | undefined; Container?: string | undefined;
    Genres: string[]; Tags: string[]; ImageTags: { Logo?: string | undefined }; MediaStreams: Stream[]; MediaSources: { Id?: string | undefined; MediaStreams: Stream[] }[];
}
export function decodeItem(v: unknown): Item {
    const r = record(v);
    return { Id: text(r.Id), Type: text(r.Type), SeriesId: text(r.SeriesId), ParentId: text(r.ParentId), RunTimeTicks: number(r.RunTimeTicks), ProductionYear: number(r.ProductionYear), CommunityRating: number(r.CommunityRating), CriticRating: number(r.CriticRating), OfficialRating: text(r.OfficialRating), Overview: text(r.Overview), Container: text(r.Container), Genres: strings(r.Genres), Tags: strings(r.Tags), ImageTags: { Logo: text(record(r.ImageTags).Logo) }, MediaStreams: list(r.MediaStreams).map(stream), MediaSources: list(r.MediaSources).map(v => { const s = record(v); return { Id: text(s.Id), MediaStreams: list(s.MediaStreams).map(stream) }; }) };
}
export const decodeItems = (v: unknown): Item[] => list(record(v).Items).map(decodeItem);
export interface PlayingSession {
    Id?: string | undefined; DeviceId?: string | undefined; NowPlayingItem: Item;
    PlayState: { PlayMethod?: string | undefined; MediaSourceId?: string | undefined; AudioStreamIndex?: number | undefined; SubtitleStreamIndex?: number | undefined };
    TranscodingInfo: { CompletionPercentage?: number | undefined; Container?: string | undefined; VideoCodec?: string | undefined; AudioCodec?: string | undefined; Bitrate?: number | undefined; TranscodeReasons: string[] } | null;
}
export function decodeSessions(v: unknown): PlayingSession[] {
    return list(v).map(v => {
        const r = record(v), p = record(r.PlayState), t = record(r.TranscodingInfo);
        return { Id: text(r.Id), DeviceId: text(r.DeviceId), NowPlayingItem: decodeItem(r.NowPlayingItem), PlayState: { PlayMethod: text(p.PlayMethod), MediaSourceId: text(p.MediaSourceId), AudioStreamIndex: number(p.AudioStreamIndex), SubtitleStreamIndex: number(p.SubtitleStreamIndex) }, TranscodingInfo: r.TranscodingInfo ? { CompletionPercentage: number(t.CompletionPercentage), Container: text(t.Container), VideoCodec: text(t.VideoCodec), AudioCodec: text(t.AudioCodec), Bitrate: number(t.Bitrate), TranscodeReasons: typeof t.TranscodeReasons === 'string' ? [t.TranscodeReasons] : strings(t.TranscodeReasons) } : null };
    });
}
export interface MediaSegment { Id?: string | undefined; Type?: string | undefined; StartTicks?: number | undefined; EndTicks?: number | undefined }
export function decodeSegments(v: unknown): MediaSegment[] {
    return list(record(v).Items).map(v => { const r = record(v); return { Id: text(r.Id), Type: text(r.Type), StartTicks: number(r.StartTicks), EndTicks: number(r.EndTicks) }; });
}

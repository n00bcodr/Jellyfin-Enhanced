/**
 * Runtime projections of the untrusted Jellyfin and plugin responses these
 * features read. They are deliberately lenient in the same way the legacy
 * optional-chaining reads were (a wrong-typed field is treated as absent), but
 * every value that reaches markup, a URL or arithmetic has a checked type.
 */

export type JsonRecord = Record<string, unknown>;
export function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function field(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}
export function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
/** Non-empty string. */
export function text(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
export function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function int(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
export function bool(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}
export function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
export function stringList(value: unknown): string[] {
    return list(value).filter((entry): entry is string => typeof entry === 'string');
}
/**
 * Provider ids arrive as strings from Jellyfin, but fixtures and older plugin
 * DTOs also carry numbers. Falsy ids (empty, 0) were "absent" for the legacy
 * truthiness checks and stay absent.
 */
export function providerId(value: unknown): string | undefined {
    if (typeof value === 'string') return value || undefined;
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return String(value);
    return undefined;
}

export interface ProviderIds { Tmdb?: string; Imdb?: string; Tvdb?: string; AniList?: string; Anilist?: string }
export interface MediaStream { Type?: string; Language?: string }
export interface MediaSource { Id?: string; MediaStreams?: MediaStream[] }
export interface DetailsItem {
    Id?: string; Type?: string; Name?: string; SeriesId?: string; SeriesName?: string;
    IndexNumber?: number; ParentIndexNumber?: number; PremiereDate?: string; DisplayOrder?: string;
    ProviderIds: ProviderIds; SeriesProviderIds: ProviderIds;
    MediaSources?: MediaSource[]; MediaStreams?: MediaStream[]; FirstEpisodeId?: string;
    Tags?: string[];
    Played?: boolean; UnplayedItemCount?: number;
}
function decodeProviderIds(value: unknown): ProviderIds {
    const ids: ProviderIds = {};
    if (!isRecord(value)) return ids;
    const tmdb = providerId(value.Tmdb), imdb = providerId(value.Imdb), tvdb = providerId(value.Tvdb);
    const aniList = providerId(value.AniList), anilist = providerId(value.Anilist);
    if (tmdb !== undefined) ids.Tmdb = tmdb;
    if (imdb !== undefined) ids.Imdb = imdb;
    if (tvdb !== undefined) ids.Tvdb = tvdb;
    if (aniList !== undefined) ids.AniList = aniList;
    if (anilist !== undefined) ids.Anilist = anilist;
    return ids;
}
function decodeStreams(value: unknown): MediaStream[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.filter(isRecord).map(stream => {
        const result: MediaStream = {};
        const type = str(stream.Type), language = str(stream.Language);
        if (type !== undefined) result.Type = type;
        if (language !== undefined) result.Language = language;
        return result;
    });
}
function decodeSources(value: unknown): MediaSource[] | undefined {
    if (!Array.isArray(value)) return undefined;
    // Entries are kept positionally: the details page counts versions.
    return value.map(source => {
        const result: MediaSource = {};
        const id = str(field(source, 'Id')), streams = decodeStreams(field(source, 'MediaStreams'));
        if (id !== undefined) result.Id = id;
        if (streams !== undefined) result.MediaStreams = streams;
        return result;
    });
}
function set<K extends keyof DetailsItem>(item: DetailsItem, key: K, value: DetailsItem[K] | undefined): void {
    if (value !== undefined) item[key] = value;
}
/** The item fields the details features read; null for a missing/cancelled lookup. */
export function decodeDetailsItem(value: unknown): DetailsItem | null {
    if (!isRecord(value)) return null;
    const item: DetailsItem = { ProviderIds: decodeProviderIds(value.ProviderIds), SeriesProviderIds: decodeProviderIds(value.SeriesProviderIds) };
    set(item, 'Id', str(value.Id));
    set(item, 'Type', str(value.Type));
    set(item, 'Name', str(value.Name));
    set(item, 'SeriesId', str(value.SeriesId));
    set(item, 'SeriesName', str(value.SeriesName));
    set(item, 'IndexNumber', num(value.IndexNumber));
    set(item, 'ParentIndexNumber', num(value.ParentIndexNumber));
    set(item, 'PremiereDate', str(value.PremiereDate));
    set(item, 'DisplayOrder', str(value.DisplayOrder));
    set(item, 'MediaSources', decodeSources(value.MediaSources));
    set(item, 'MediaStreams', decodeStreams(value.MediaStreams));
    set(item, 'FirstEpisodeId', str(field(value.FirstEpisode, 'Id')));
    if (Array.isArray(value.Tags)) item.Tags = stringList(value.Tags);
    const userData = value.UserData;
    set(item, 'Played', bool(field(userData, 'Played')));
    set(item, 'UnplayedItemCount', num(field(userData, 'UnplayedItemCount')));
    return item;
}
/** Items of a `{ Items: [...] }` query response. */
export function decodeItems(value: unknown): DetailsItem[] {
    return list(field(value, 'Items')).map(decodeDetailsItem).filter((item): item is DetailsItem => item !== null);
}

/** Error fields the plugin API attaches (HttpError.status / responseJSON). */
export interface ErrorShape { status?: number; message?: string; responseCode?: string; responseMessage?: string; retryAfterSeconds?: number }
export function errorShape(error: unknown): ErrorShape {
    const shape: ErrorShape = {};
    const status = num(field(error, 'status')), message = str(field(error, 'message'));
    const json = field(error, 'responseJSON');
    const code = str(field(json, 'code')), responseMessage = str(field(json, 'message'));
    const retry = num(field(json, 'retryAfterSeconds'));
    if (status !== undefined) shape.status = status;
    if (message !== undefined) shape.message = message;
    if (code !== undefined) shape.responseCode = code;
    if (responseMessage !== undefined) shape.responseMessage = responseMessage;
    if (retry !== undefined) shape.retryAfterSeconds = retry;
    return shape;
}
export function errorMessage(error: unknown): string {
    return errorShape(error).message || '';
}

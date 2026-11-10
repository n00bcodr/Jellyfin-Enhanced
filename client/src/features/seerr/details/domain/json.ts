/** Narrowing for Seerr, TMDB and Jellyfin replies, which arrive as untrusted JSON. */
export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function record(value: unknown): JsonRecord | null {
    return isRecord(value) ? value : null;
}
export function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
/** A non-empty string; Seerr sends '' and null interchangeably for "no value". */
export function filled(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
export function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function list(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}
export function records(value: unknown): JsonRecord[] {
    return list(value).filter(isRecord);
}
/** An id as text: Seerr ids are numbers, DOM and URL ids are strings. */
export function idText(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return filled(value);
}
export function detailOf(event: Event): JsonRecord | null {
    return event instanceof CustomEvent ? record(event.detail) : null;
}

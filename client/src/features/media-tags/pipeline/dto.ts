/** Unvalidated JSON from Jellyfin, the plugin or browser storage: every read is `unknown`. */
export type JsonRecord = Readonly<Record<string, unknown>>;

const EMPTY: JsonRecord = Object.freeze({});

/** Cross-realm safe: test and host objects need not share this bundle's Object. */
export function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function record(value: unknown): JsonRecord { return isRecord(value) ? value : EMPTY; }
export function records(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.filter(isRecord) : []; }
export function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
/**
 * A list with its members in place, for reads that must meet a bad member rather than skip it. Those reads stop there,
 * so the group draws nothing for that card, and native posters mirror exactly where (QualityTagRules.Detect,
 * LanguageFlagRules.Resolve). `records` and `stringList` are for lists whose bad members are simply ignored.
 */
export function members(value: unknown): readonly unknown[] {
    if (!value) return [];
    if (!Array.isArray(value)) throw new TypeError('Expected a list');
    return value;
}
/** A member read as an object: a missing one stops the read, any other value has no fields. */
export function memberRecord(value: unknown): JsonRecord {
    if (value === null || value === undefined) throw new TypeError('Read a missing list member');
    return record(value);
}
/** A member read as text: anything else stops the read. */
export function memberText(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('Read a list member that is not text');
    return value;
}
/** A non-empty string, else null. */
export function text(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
export function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
/** Item ids compare lowercase without dashes, however a card, cache entry or server spelled them. */
export function normalizeItemId(id: unknown): string { return String(id).replace(/-/g, '').toLowerCase(); }
/** A provider or Jellyfin id scalar as text; objects never become ids. */
export function idText(value: unknown): string | null {
    return (typeof value === 'string' && value) || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
}
/** Read a key in camelCase or its PascalCase spelling. */
export function either(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] ?? value[key.charAt(0).toUpperCase() + key.slice(1)] : undefined;
}
/** Status code carried by a transport error, or 0. */
export function errorStatus(error: unknown): number {
    return isRecord(error) && typeof error.status === 'number' ? error.status : 0;
}
/** A table lookup that never answers from Object.prototype ("constructor" is a valid label to look up). */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

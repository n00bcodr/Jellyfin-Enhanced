/**
 * @file JSON values of the plugin configuration the Media Tags admin tab edits.
 * The configuration and every server answer are untrusted JSON: they are
 * checked here once, at the boundary, and read through these narrowing helpers.
 */
import type { JsonValue } from '../../../contracts/generated';

/** The plugin configuration (PascalCase fields), as the page's working copy holds it. */
export type Config = { [key: string]: JsonValue | undefined };
/** A JSON object value. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Whether a value is JSON (finite numbers, no functions or undefined members).
 * @param value
 * @returns {boolean}
 */
export function isJson(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJson);
    // Any realm's plain objects (a test realm's, or the page's): only their members are checked.
    if (typeof value === 'object') return Object.values(value).every(isJson);
    return false;
}

/**
 * Whether a JSON value is an object (not an array).
 * @param value
 * @returns {boolean}
 */
export function isObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A configuration document from the server or a caller: a JSON object whose
 * members are JSON (an `undefined` member counts as absent). Anything else is
 * refused, so a malformed answer is never taken for the stored settings.
 * @param value
 * @returns {Config|null}
 */
export function configOf(value: unknown): Config | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Config = {};
    for (const [key, member] of Object.entries(value)) {
        if (member === undefined) continue;
        if (!isJson(member)) return null;
        out[key] = member;
    }
    return out;
}

/**
 * A deep copy (JSON values only); undefined becomes null, as the page always copied.
 * @param value
 * @returns {JsonValue}
 */
export function copy(value: unknown): JsonValue {
    if (value === undefined) return null;
    const out: unknown = JSON.parse(JSON.stringify(value));
    return isJson(out) ? out : null;
}

/**
 * Whether two JSON values are equal (null and missing alike).
 * @param a
 * @param b
 * @returns {boolean}
 */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Read a key in either case (the server sends PascalCase, older documents camelCase).
 * A null or missing camelCase member falls back to the PascalCase one.
 * @param obj
 * @param key - camelCase.
 * @returns {JsonValue|undefined}
 */
export function pick(obj: JsonValue | undefined, key: string): JsonValue | undefined {
    if (!isObject(obj)) return undefined;
    const own = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
    if (own !== undefined && own !== null) return own;
    const pascal = key.charAt(0).toUpperCase() + key.slice(1);
    const other = Object.prototype.hasOwnProperty.call(obj, pascal) ? obj[pascal] : undefined;
    return other !== undefined && other !== null ? other : undefined;
}

/**
 * Read a key as the rules editor always did: the camelCase member when it is not
 * undefined (null included), else the PascalCase one.
 * @param obj
 * @param key - camelCase.
 * @returns {JsonValue|undefined}
 */
export function either(obj: JsonValue | undefined, key: string): JsonValue | undefined {
    if (!isObject(obj)) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) return obj[key];
    const pascal = key.charAt(0).toUpperCase() + key.slice(1);
    return Object.prototype.hasOwnProperty.call(obj, pascal) ? obj[pascal] : undefined;
}

/**
 * `String(value || '')` for a JSON value (falsy values read as empty).
 * @param value
 * @returns {string}
 */
export const text = (value: JsonValue | undefined): string => (value ? String(value) : '');

/**
 * An own member of a lookup table, else undefined (never an inherited one).
 * @param table
 * @param key
 * @returns {T|undefined}
 */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * The array a JSON value holds, else an empty one.
 * @param value
 * @returns {JsonValue[]}
 */
export const list = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

/**
 * The JSON objects of a JSON value that is an array.
 * @param value
 * @returns {JsonObject[]}
 */
export const objects = (value: JsonValue | undefined): JsonObject[] => list(value).filter(isObject);

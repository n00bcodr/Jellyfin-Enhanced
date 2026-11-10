import type { JsonValue } from '../../contracts/generated';

/**
 * Readers for untrusted settings/config JSON values that reproduce the
 * coercions the legacy panel relied on (array indexing by a stored number or
 * numeric string, arithmetic on stored positions), without `any`.
 */
type Value = JsonValue | undefined;

/** The array index a stored value names (`list[value]` in the legacy code), or undefined. */
export function indexKey(value: Value): number | undefined {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : undefined;
    if (typeof value === 'string' && value !== '' && String(Number(value)) === value) {
        const n = Number(value);
        return Number.isInteger(n) && n >= 0 ? n : undefined;
    }
    return undefined;
}

/** `list[value ?? fallback]`: the entry a stored index selects. */
export function entryAt<T>(list: readonly T[], value: Value, fallback: number): T | undefined {
    const key = indexKey(value ?? fallback);
    return key === undefined ? undefined : list[key];
}

/** JavaScript's numeric coercion of a stored value (`100 - value`), with `??` defaulting first. */
export function numeric(value: Value, fallback: number): number {
    const v = value ?? fallback;
    return typeof v === 'number' ? v : Number(v);
}

/** A stored string, or undefined for any other JSON type. */
export function stringValue(value: Value): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** A stored boolean, or undefined for any other JSON type. */
export function booleanValue(value: Value): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

/** A finite stored number, or undefined. */
export function finiteNumber(value: Value): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A JSON object (not an array), or undefined. */
export function objectValue(value: Value): { [key: string]: JsonValue } | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** A JSON array, or undefined. */
export function arrayValue(value: Value): JsonValue[] | undefined {
    return Array.isArray(value) ? value : undefined;
}

/** The value interpolated into markup or CSS the way a template literal would. */
export function text(value: Value): string {
    return String(value);
}

/** Whether a value is plain JSON (what JSON.parse returns). */
export function isJson(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJson);
    if (typeof value === 'object') return Object.values(value).every(isJson);
    return false;
}

/**
 * Whether a stored colour may go into CSS text (a stylesheet rule or a style attribute): a hex colour,
 * rgb()/rgba()/hsl()/hsla() or a keyword such as `transparent`, accepted by the browser when it can tell.
 * Anything with `;`, quotes or braces could add a declaration or leave the attribute.
 */
export function isSafeCssColor(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (!/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+|(?:rgba?|hsla?)\([\d\s.,%/+-]*\))$/i.test(v)) return false;
    return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('color', v);
}

/** Whether a font-family list may go into CSS text: names, spaces, commas, dots, hyphens and paired single quotes. */
export function isSafeFontFamily(value: unknown): value is string {
    return typeof value === 'string' && /^[\w\s,.'-]+$/.test(value) && (value.split("'").length - 1) % 2 === 0;
}

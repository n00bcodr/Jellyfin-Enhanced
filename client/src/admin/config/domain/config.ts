import type { JsonValue } from '../../../contracts/generated';

export type { JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** PluginConfiguration as the server sends it: every field is kept, known to this page or not. */
export type AdminConfig = { [key: string]: JsonValue | undefined };

export function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject {
    return isObject(value) ? value : {};
}

export function asList(value: unknown): JsonValue[] {
    return Array.isArray(value) ? value : [];
}

export function asObjects(value: unknown): JsonObject[] {
    return asList(value).filter(isObject);
}

/** A string, or the fallback for any other value. */
export function text(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

/** A finite number, or the fallback for any other value. */
export function num(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** What assigning a stored value to a form control shows: strings and numbers as they are, nothing otherwise. */
export function shown(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** The strings of a JSON array; anything else reads as empty. */
export function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

import type { JsonRecord } from '../../host/bootstrap-pages-host';

export const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null;
const isDocument = (value: unknown): value is JsonRecord => isRecord(value) && !Array.isArray(value);

/** Fresh own keys only, so a stored `__proto__` stays data and is never a prototype write. */
function convertKeys(value: unknown, convert: (key: string) => string): unknown {
    if (!isDocument(value)) return value; // Primitives and arrays pass through as-is.
    return Object.fromEntries(Object.keys(value).map(key => [convert(key), convertKeys(value[key], convert)]));
}
/** PascalCase object keys to camelCase, recursively. */
export const toCamelCase = (value: unknown): unknown =>
    convertKeys(value, key => key.charAt(0).toLowerCase() + key.slice(1));
/** camelCase object keys to PascalCase, recursively. */
export const toPascalCase = (value: unknown): unknown =>
    convertKeys(value, key => key.charAt(0).toUpperCase() + key.slice(1));

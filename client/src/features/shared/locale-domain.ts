export interface LocaleResult {translations: Record<string,string>; usedLang: string}
/**
 * Preserve translation markup verbatim: rendering/escaping belongs to the caller.
 * The dictionary is checked where it stands and returned as it is. Every caller hands over an object it has just
 * parsed (JSON.parse or Response.json), so nothing else holds it, and copying each of its ~1,400 keys with
 * Object.defineProperty cost about 4 ms of main thread on every page load (two locales, cold code).
 */
function isTranslations(value: object): value is Record<string,string> {
 for (const [key, text] of Object.entries(value)) {
  if (typeof text !== 'string') throw new Error(`Invalid translation: ${key}`);
 }
 return true;
}
export function decodeTranslations(value: unknown): Record<string,string> {
 if (!value || typeof value !== 'object' || Array.isArray(value) || !isTranslations(value)) throw new Error('Invalid locale dictionary');
 return value;
}

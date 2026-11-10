export interface LocaleResult {translations: Record<string,string>; usedLang: string}
/** Preserve translation markup verbatim: rendering/escaping belongs to the caller. */
export function decodeTranslations(value: unknown): Record<string,string> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid locale dictionary');
 const result: Record<string,string> = {};
 for (const [key, text] of Object.entries(value)) {
  if (typeof text !== 'string') throw new Error(`Invalid translation: ${key}`);
  Object.defineProperty(result, key, {value: text, enumerable: true, writable: true, configurable: true});
 }
 return result;
}

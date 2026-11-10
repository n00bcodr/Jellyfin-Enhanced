import type { LoaderNamespace, Translate, TranslationParams } from '../../host/bootstrap-pages-host';

const PLURAL_PARAMS = ['count', 'days', 'n', 'items', 'hours', 'minutes', 'seconds'];
type Scope = Pick<LoaderNamespace, 'translations' | 'translationsFromEnglish' | 'translationsLang' | 'IconName' | 'icon'>;

/** Reads `scope` on every call so a locale, icon set or namespace loaded later applies. */
export function createTranslator(scope: () => Scope | undefined): Translate {
    return (key: string, params: TranslationParams | null = {}) => {
        const translations = scope()?.translations ?? {};
        let text = translations[key] || key;
        // Plural forms: `${key}_one`, `_few`… by the CLDR category (Intl.PluralRules, English rules for a
        // language it does not know) of the count, in the language the string is written in, falling back
        // to `${key}_other`, then the key. A form English filled in for a locale is used only where the key
        // itself is English (or the locale is a kind of English), so a translated sentence never turns
        // English for one count.
        const counted = params ? PLURAL_PARAMS.find(name => {
            const value = params[name];
            return typeof value === 'number' && Number.isFinite(value);
        }) : undefined;
        if (params && counted && translations[key]) {
            const english = scope()?.translationsFromEnglish;
            const ownLang = scope()?.translationsLang || 'en';
            const keyIsEnglish = !!english?.has(key);
            const lang = keyIsEnglish ? 'en' : ownLang;
            const sameSource = (variant: string) => variant in translations
                && (!english || keyIsEnglish === english.has(variant) || /^en\b/i.test(ownLang));
            let category = 'other';
            try { category = new Intl.PluralRules([lang, 'en']).select(Number(params[counted])); } catch { /* malformed tag: other */ }
            const variant = [`${key}_${category}`, `${key}_other`].find(sameSource);
            if (variant) text = translations[variant] ?? text;
        }
        if (params) {
            for (const [param, value] of Object.entries(params)) {
                // A function, so a value is inserted as written ("$&" or "$$" in a title are not replacement patterns).
                text = text.replace(new RegExp(`{${param}}`, 'g'), () => String(value));
            }
        }
        // Replace {{icon:name}} tokens with JE.icon() calls.
        return text.replace(/\{\{icon:([a-zA-Z]+)\}\}/g, (match: string, iconName: string) => {
            const iconKey = iconName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
            const iconConstant = scope()?.IconName?.[iconKey];
            // If IconName is not loaded yet, keep the placeholder.
            if (!iconConstant) {
                console.debug(`[JE.t] IconName.${iconKey} not available yet, keeping placeholder`);
                return match;
            }
            const iconResult = scope()?.icon?.(iconConstant);
            // If the icon function returns a pending token, keep the original placeholder.
            if (iconResult && iconResult.startsWith('{{ICON_PENDING:')) {
                console.debug(`[JE.t] Icon system not ready, keeping placeholder for ${iconName}`);
                return match;
            }
            return iconResult || match;
        });
    };
}

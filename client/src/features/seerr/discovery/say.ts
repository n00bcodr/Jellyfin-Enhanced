import type { Say } from './types';

/**
 * A string in the viewer's language, or the source's English where the key has no translation, with its
 * `{name}` placeholders filled.
 */
export function createSay(JE: { t?(key: string, params?: Record<string, string | number>): string }): Say {
    return (key, fallback, values) => {
        const text = typeof JE.t === 'function' ? JE.t(key, values) : '';
        let said = text && text !== key ? text : fallback;
        for (const [name, value] of Object.entries(values ?? {})) said = said.replace(`{${name}}`, () => String(value));
        return said;
    };
}

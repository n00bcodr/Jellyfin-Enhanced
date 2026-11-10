import { isNumber, isRecord, isString } from './decode';
import type { OverrideRule, RequestSettingsOverride } from './types';

/** The media fields override rules match on, read from whatever item or details document a caller passes. */
export interface RuleMedia {
    originalLanguage: string | null;
    /** Undefined when the document carries no genreIds (genre rules are then not checked, as before). */
    genreIds: string[] | undefined;
    genreNames: string[];
    keywordNames: string[] | undefined;
}
export function ruleMedia(value: unknown): RuleMedia {
    if (!isRecord(value)) return { originalLanguage: null, genreIds: undefined, genreNames: [], keywordNames: undefined };
    const names = (list: unknown): string[] => Array.isArray(list)
        ? list.map(entry => isRecord(entry) && isString(entry.name) ? entry.name.toLowerCase() : '') : [];
    // Spoiler Guard moves a protected title's keywords to jeRuleKeywords so rules still see them.
    const keywords: unknown = value.jeRuleKeywords || value.keywords;
    return {
        originalLanguage: isString(value.originalLanguage) && value.originalLanguage ? value.originalLanguage : null,
        genreIds: Array.isArray(value.genreIds) ? value.genreIds.filter(id => isNumber(id) || isString(id)).map(String) : undefined,
        genreNames: names(value.genres),
        // A non-list keyword field matches no keyword rule.
        keywordNames: keywords ? names(keywords) : undefined
    };
}

const split = (value: string, separator: string): string[] => value.split(separator).map(part => part.trim());
function ruleTags(tags: OverrideRule['tags']): number[] | undefined {
    if (Array.isArray(tags)) return tags.map(tag => isNumber(tag) ? tag : parseInt(tag, 10)).filter(tag => !Number.isNaN(tag));
    if (isString(tags)) return split(tags, '|').map(tag => parseInt(tag, 10)).filter(tag => !Number.isNaN(tag));
    if (isNumber(tags)) return [tags];
    return undefined;
}

/**
 * The first applicable rule's settings, or null. Movies use rules with a Radarr
 * service, TV rules with a Sonarr service. `currentUser` is asked only when a
 * rule restricts users; a rule whose users cannot be checked does not match.
 */
export async function matchOverrideRule(rules: readonly OverrideRule[], media: RuleMedia, mediaType: string,
    currentUser: () => Promise<string | null>): Promise<{ rule: OverrideRule; settings: RequestSettingsOverride } | null> {
    const serviceIdKey = mediaType === 'movie' ? 'radarrServiceId' : 'sonarrServiceId';
    for (const rule of rules) {
        const serviceId = rule[serviceIdKey];
        if (serviceId === null || serviceId === undefined) continue;
        if (rule.language && media.originalLanguage) {
            const allowed = split(rule.language, '|').map(language => language.toLowerCase());
            if (!allowed.includes(media.originalLanguage.toLowerCase())) continue;
        }
        if (rule.genre && media.genreIds) {
            const ruleGenres = split(rule.genre, '|').map(genre => genre.toLowerCase());
            const ids = media.genreIds;
            if (!ruleGenres.some(genre => media.genreNames.includes(genre) || ids.includes(genre))) continue;
        }
        if (rule.keywords && media.keywordNames) {
            const ruleKeywords = split(rule.keywords, '|').map(keyword => keyword.toLowerCase());
            const names = media.keywordNames;
            if (!ruleKeywords.some(keyword => names.includes(keyword))) continue;
        }
        if (rule.users) {
            const user = await currentUser();
            if (!user || !split(rule.users, ',').includes(user)) continue;
        }
        const settings: RequestSettingsOverride = { serverId: serviceId };
        if (rule.profileId !== null && rule.profileId !== undefined) settings.profileId = rule.profileId;
        if (rule.rootFolder) settings.rootFolder = rule.rootFolder;
        const tags = rule.tags ? ruleTags(rule.tags) : undefined;
        if (tags) settings.tags = tags;
        return { rule, settings };
    }
    return null;
}

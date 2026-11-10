import { KIND_LOOKS_ATTR, type KindLooks, kindLooksCss, kindLooksOf, pinKindLooks } from './kind-looks';
import * as rules from './layout-rules';
import { DEFAULT_ORDER, ENABLED_SETTING, type Group, type LayoutDocument, type LayoutSettings, type ShapeLook, TAG_GAPS, TAG_SCALES } from './layout-rules';
import type { LayoutHost } from './layout-runtime-types';
import type { LayoutFns, LayoutState } from './state';

/**
 * Settings and looks: the cached layout settings, per-look settings, sizes and the stylesheet.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createLooks(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    function requireLook() { const look = JE.core.tagLook; if (!look)
        throw new Error('Tag looks must load before resolving item rules'); return look; }

    const normalizeSettings = (settings?: LayoutDocument | null, plugin?: LayoutDocument | null) => rules.normalizeSettings(settings ?? JE.currentSettings, plugin ?? JE.pluginConfig, kindLooksOf);

    const isLegacySettings = (settings?: LayoutDocument | null) => rules.isLegacySettings(settings ?? JE.currentSettings);

    const singleChipGroup = (group: Group, config = JE.pluginConfig) => rules.singleChipGroup(group, config);

    const promoteLegacySettings = (settings?: LayoutDocument | null) => {
        const source = settings ?? JE.currentSettings;
        const changed = rules.promoteLegacySettings(source);
        if (changed && source) pinKindLooks(source, JE.pluginConfig);
        if (changed && source === JE.currentSettings) invalidateSettings();
        return changed;
    };

    const lookSettingsCache = new Map<string, LayoutSettings>();

    const lookSettings = (base: LayoutSettings, look: ShapeLook, locked: boolean) => {
        const settings = rules.lookSettings(base, look, locked, JE.currentSettings, JE.pluginConfig);
        const key = settings.lookKey + '|' + (settings.order ? 'o' : '');
        const cached = lookSettingsCache.get(key);
        if (cached)
            return cached;
        lookSettingsCache.set(key, settings);
        return settings;
    };

    function applySize(element: HTMLElement, conf: LayoutSettings) {
        element.style.setProperty('--je-tag-scale', String((TAG_SCALES[conf.tagScale] ?? 1)));
        element.style.setProperty('--je-tag-gap', String((TAG_GAPS[conf.tagGap] ?? 1)));
        const id = kindLooksId(conf.kindLooks);
        if (id) element.setAttribute(KIND_LOOKS_ATTR, id);
        else if (element.hasAttribute(KIND_LOOKS_ATTR)) element.removeAttribute(KIND_LOOKS_ATTR);
    }

    // Kind looks (kind-looks.ts): each set in use gets a number, and one stylesheet holds the rules of every set, so a
    // card costs one lookup (its settings object is cached) and one attribute. Settings with no kind look add nothing.
    const KIND_LOOKS_STYLE = 'je-tag-kind-looks';
    const MAX_KIND_LOOK_SETS = 32;
    const kindLookIdOf = new WeakMap<KindLooks, string>();
    const kindLookSets = new Map<string, { id: number; looks: KindLooks }>();
    let kindLookSeq = 0;
    function kindLooksId(looks: KindLooks | undefined): string {
        if (!looks) return '';
        const known = kindLookIdOf.get(looks);
        if (known !== undefined) return known;
        const key = Object.entries(looks).map(([kind, look]) => `${kind}:${look.opacity}:${look.scale}`).join(',');
        let set = key ? kindLookSets.get(key) : undefined;
        if (key) {
            // Most recently resolved last; the oldest sets (settings since changed) leave the sheet first.
            const added = !set;
            if (set) kindLookSets.delete(key);
            else set = { id: ++kindLookSeq, looks };
            kindLookSets.set(key, set);
            for (const old of kindLookSets.keys()) {
                if (kindLookSets.size <= MAX_KIND_LOOK_SETS) break;
                kindLookSets.delete(old);
            }
            if (added) JE.core.ui?.injectCss(KIND_LOOKS_STYLE, [...kindLookSets.values()].map((entry) => kindLooksCss(entry.looks, entry.id)).join('\n'));
        }
        const id = set ? String(set.id) : '';
        kindLookIdOf.set(looks, id);
        return id;
    }

    function settingsSource() {
        const s = JE.currentSettings;
        return { settings: s, plugin: JE.pluginConfig, enabled: DEFAULT_ORDER.map((g) => (s?.[ENABLED_SETTING[g]] ? '1' : '0')).join('') };
    }

    function currentSettings() {
        const source = settingsSource();
        if (!s.cachedSettings || !s.cachedSource || s.cachedSource.settings !== source.settings
            || s.cachedSource.plugin !== source.plugin || s.cachedSource.enabled !== source.enabled) {
            s.cachedSettings = normalizeSettings();
            s.cachedSource = source;
        }
        return s.cachedSettings;
    }

    function invalidateSettings() {
        lookSettingsCache.clear();
        s.cachedSettings = null;
        s.cachedLooks = null;
    }

    function currentLooks() {
        if (!s.cachedLooks)
            s.cachedLooks = JE.core.tagLook?.read() || { rules: [], locks: new Map(), overrides: new Map() };
        if (!s.cachedLooks.overrides)
            s.cachedLooks.overrides = new Map();
        return s.cachedLooks;
    }

    function injectStyles() {
        if (s.stylesInjected || typeof deps.api.buildStyles !== 'function' || !JE.core.ui?.injectCss)
            return;
        s.stylesInjected = true;
        JE.core.ui.injectCss('je-tag-layout', deps.api.buildStyles());
        window.addEventListener('resize', refitOnResize, { passive: true });
    }

    function refitOnResize() {
        if (s.resizeQueued)
            return;
        s.resizeQueued = true;
        requestAnimationFrame(() => {
            s.resizeQueued = false;
            for (const host of document.querySelectorAll<HTMLElement>('.je-tag-host')) {
                const ctrl = s.controllers.get((host));
                if (ctrl)
                    deps.scheduleFit(ctrl);
            }
        });
    }

    return { requireLook, normalizeSettings, isLegacySettings, singleChipGroup, promoteLegacySettings, lookSettings, applySize, settingsSource, currentSettings, invalidateSettings, currentLooks, injectStyles };
}

import { settingsUi } from '../host';
import { tagRulesHost } from '../rules-host';
import { createTagLayout } from './tag-layout';
const bridge = tagRulesHost();
bridge.core ??= {};
const layout = createTagLayout({
    get currentSettings() { return bridge.currentSettings || {}; },
    get pluginConfig() { return bridge.pluginConfig || {}; },
    core: {
        get tagLook() { return bridge.core?.tagLook; },
        ui: { injectCss: (id, css) => bridge.core?.ui?.injectCss(id, css) },
        dom: { afterNextPaint: callback => bridge.core?.dom?.afterNextPaint ? bridge.core.dom.afterNextPaint(callback) : requestAnimationFrame(callback) },
        tagRenderer: { isIgnoredContext: element => bridge.core?.tagRenderer?.isIgnoredContext(element) ?? false },
        tagScopes: { excludes: (group, element) => bridge.core?.tagScopes?.excludes(group, element) ?? false },
    },
    // Resolve these services at call time: their ordered entries follow the layout.
    tagPosterColours: {
        track: host => bridge.tagPosterColours?.track(host),
        release: host => bridge.tagPosterColours?.release(host),
    },
    session: { onUserChange: (name, callback) => bridge.session?.onUserChange?.(name, callback) },
    t: (key, values) => bridge.t(key, values),
});
// The admin configuration page's Media Tags tab checks the settings registry through this facade, with tagLayout (step C4).
bridge.mediaTagsSettingsUi = { get registry() { return settingsUi(bridge); } };
bridge.core.tagLayout = layout;
bridge.reinitializeTagLayout = layout.reinitialize;

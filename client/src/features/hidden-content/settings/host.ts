/**
 * hidden-content's host for its settings panel (step C4): the panel bridge and the shared settings registry
 * `JE.internals.enhancedUi`, which hidden-content co-owns with settings-panel and media-tags
 * (tests/frontend/architecture/internals-owners.json, frontend.md §2.4). `panelHost()` is the shell's own copy in
 * features/shared/panel-host.ts, and `registry()` is the same code as settings-panel/host.ts's (rule 3 keeps it in an
 * owner's host). Not ../host.ts: that one requires ApiClient when it loads.
 */
import type { EnhancedUi, PanelBridge } from '../../settings-panel/public-api';
export type { HiddenContentSettingKey, PanelBridge } from '../../settings-panel/public-api';

export { panelHost } from '../../shared/panel-host';

/** The shared panel registry (`JE.internals.enhancedUi`), created on first use like the legacy modules. */
export function registry(JE: Pick<PanelBridge, 'internals'>): EnhancedUi {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
}

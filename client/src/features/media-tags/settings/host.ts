/**
 * media-tags' host for its settings panels (step C4): the panel bridge and the shared settings registry
 * `JE.internals.enhancedUi`, which media-tags co-owns with settings-panel and hidden-content
 * (tests/frontend/architecture/internals-owners.json, frontend.md §2.4). The bridge and ApiClient reads are the shell's
 * own copy in features/shared/panel-host.ts, and `registry()` is the same code as settings-panel/host.ts's (rule 3 keeps
 * it in an owner's host), so a panel behaves the same with or without the shell loaded.
 */
import type { EnhancedUi, PanelBridge } from '../../settings-panel/public-api';
export type { CustomTagRule, PanelApiClient, PanelBridge, PanelTagLayout, PluginConfig, Settings } from '../../settings-panel/public-api';

export { apiClient, currentUserKey, optionalApiClient, panelHost } from '../../shared/panel-host';

/** The shared panel registry (`JE.internals.enhancedUi`), created on first use like the legacy modules. */
export function registry(JE: Pick<PanelBridge, 'internals'>): EnhancedUi {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
}

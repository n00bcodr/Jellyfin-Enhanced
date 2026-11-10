/**
 * settings-panel's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these
 * with `import type … from '…/settings-panel/public-api'` (feature-boundaries rule 1); everything else in this
 * folder is private to the panel shell.
 */
export type { PanelContext, SearchHit } from './context';
export type { EnhancedUi, SettingsSection } from './registry';
// Step C4: the bridge types the Media Tags and Hidden Content panels' own hosts (settings/host.ts there) use.
export type { CustomTagRule, HiddenContentSettingKey, PanelApiClient, PanelBridge, PanelTagLayout, PluginConfig, Settings } from './host';
// S2: nothing else is imported from outside this folder today (C1 moved host/settings-panel-host.ts here as
// host.ts, which takes `EnhancedUi` from registry.ts directly).

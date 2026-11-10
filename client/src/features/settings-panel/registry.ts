import type { PanelContext } from './context';
import type { FeatureName } from '../../host/context';
import type { MediaTagsSettingsUi } from '../media-tags/public-api';

/**
 * A feature's own section of the settings panel, registered under `EnhancedUi.sections[<feature>]`
 * (frontend.md §1a). Nothing registers one yet; step A5 moves per-feature toggles here.
 */
export interface SettingsSection {
    buildHtml?: (ctx: PanelContext) => string;
    wire?: (ctx: PanelContext) => void;
}

/**
 * `JE.internals.enhancedUi`: the registry the split panel modules share
 * (and that admin pages and the item editor read). Every member is optional:
 * each module fills its own part when it loads, in manifest order.
 * The shell's members are declared here; the Media Tags panels' members are
 * `MediaTagsSettingsUi` (media-tags/public-api.ts), on the same runtime object.
 */
export interface EnhancedUi extends MediaTagsSettingsUi {
    GITHUB_REPO?: string;
    showReleaseNotesNotification?: () => Promise<void>;
    buildPanelHtml?: (ctx: PanelContext) => string;
    buildPanelSizeControlsHtml?: () => string;
    buildPanelResizeHandlesHtml?: () => string;
    wirePanelResize?: (ctx: PanelContext) => void;
    wireShortcutEditor?: (ctx: PanelContext) => void;
    wireSettingsListeners?: (ctx: PanelContext) => void;
    wireMiscSettingsControls?: (ctx: PanelContext) => void;
    removeTagGroup?: (group: string, containerClass: string) => void;
    syncSubtitlePreviewTextShadow?: (bgColor: string) => void;
    wireHiddenContentListeners?: (ctx: PanelContext) => void;
    wireLanguageControls?: (ctx: PanelContext) => void;
    sections?: Partial<Record<FeatureName, SettingsSection>>;
}

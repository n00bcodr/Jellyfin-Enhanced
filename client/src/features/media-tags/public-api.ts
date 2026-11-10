/**
 * media-tags' public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/media-tags/public-api'` (feature-boundaries rule 1).
 */
import type { PanelContext } from '../settings-panel/public-api';
import type { TagGroupEditorApi, TagGroupEditorData } from './settings/ui-panel-tag-editor';
import type { TagLooksPanel } from './settings/ui-panel-tag-looks';
import type { TagPortableReopen, TagPortableTools, WireTagPortable } from './settings/ui-panel-tag-portable';
import type {
    PreviewInteraction, PreviewInteractionOptions, TagPreview, TagPreviewData, TagPreviewOptions,
} from './settings/ui-panel-tag-preview';

// The Media Tags settings panels' registry members and their types.
export type { TagGroupEditorApi, TagGroupEditorData } from './settings/ui-panel-tag-editor';
export type { TagLooksPanel } from './settings/ui-panel-tag-looks';
export type { TagPortableReopen, TagPortableTools, WireTagPortable } from './settings/ui-panel-tag-portable';
export type { PreviewInteraction, PreviewInteractionOptions, TagPreview, TagPreviewData, TagPreviewOptions } from './settings/ui-panel-tag-preview';

/**
 * media-tags' `JE.mediaTagsSettingsUi` facade (step C4), published by core/tag-layout.js together with
 * `JE.core.tagLayout`. `registry` forwards, on each read, the settings registry `JE.internals.enhancedUi` (where the
 * Media Tags panels put their members): the admin configuration page's Media Tags tab waits for it before it draws.
 */
export interface MediaTagsSettingsUiFacade { readonly registry: MediaTagsSettingsUi | undefined }

/** The open hub's controls other sections and tests drive (settings/ui-panel-media-tags.ts). */
export interface MediaTagsHubApi {
    openTab(tab: string, options?: { focus?: boolean; focusTab?: boolean }): boolean;
    announce(message: string): void;
    refreshPreview(): void;
    hasPreview(): boolean;
    searchIndex(): Array<{ label: string; path: string; el: HTMLElement }>;
    reveal(el: HTMLElement): void;
    dispose(): void;
}

/**
 * The Media Tags panels' members of `JE.internals.enhancedUi` (settings-panel/registry.ts `EnhancedUi` extends
 * this; same runtime object and key). Every member is optional: each settings/ module fills its own part when it
 * loads, in manifest order.
 */
export interface MediaTagsSettingsUi {
    buildMediaTagsHubHtml?: (ctx: PanelContext) => string;
    wireMediaTagsHub?: (ctx: PanelContext) => void;
    wireTagLooks?: (ctx: PanelContext) => void;
    tagLooksPanel?: TagLooksPanel;
    tagPortable?: TagPortableTools;
    buildTagPortableHtml?: () => string;
    wireTagPortable?: WireTagPortable;
    tagPortableReopen?: TagPortableReopen | null;
    wireTagGroupEditor?: (ctx: PanelContext) => void;
    buildTagGroupEditorHtml?: (ctx: PanelContext) => string;
    tagGroupEditor?: TagGroupEditorApi | null;
    tagGroupEditorData?: TagGroupEditorData;
    mediaTagsHub?: MediaTagsHubApi | null;
    bindTagPreviewInteraction?: (cards: readonly HTMLElement[], view: HTMLElement, options?: PreviewInteractionOptions) => PreviewInteraction;
    createTagPreview?: (mount: HTMLElement | null, options?: TagPreviewOptions) => TagPreview | null;
    tagPreviewData?: TagPreviewData;
}
// Types code outside this folder imported in S2 (host/tag-runtime-host.ts, host/tag-rules-host.ts,
// host/settings-panel-host.ts). C1 moved the first two into this feature (host.ts, rules-host.ts); the moved
// settings-panel/host.ts takes MediaLanguage, PosterColours, RatingSources, TagLayout and TagLook from here.
export type { LanguageConfig, LanguageSettings, MediaLanguage } from './types/language/media-language';
export type { PosterColours } from './layout/poster-colours';
export type { RatingConfig, RatingSettings, RatingSources } from './types/ratings/rating-sources';
export type { statusVocabulary } from './types/status/status-vocabulary';
export type { TagLayout } from './layout/tag-layout';
export type { TagLook } from './layout/tag-look';
export type { PipelineApi, RendererApi } from './pipeline/contract';
export type { JsonRecord } from './pipeline/dto';
export type { TagScopes, TagSettingsMatrix } from './pipeline/scopes';
export type { TagCacheStore } from './pipeline/tag-cache-store';
export type { DirectPlay } from './types/direct-play/tag-direct-play';
export type { ItemEditor } from './editor/tag-item-editor';

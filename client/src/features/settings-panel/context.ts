import type { Shortcut } from './host';

/** Theme constants resolved when the panel opens (themer values may be absent). */
export interface PanelTheme {
    panelBgColor: string | undefined;
    headerFooterBg: string | undefined;
    detailsBackground: string | undefined;
    primaryAccentColor: string | undefined;
    toggleAccentColor: string | undefined;
    kbdBackground: string | undefined;
    presetBoxBackground: string | undefined;
    githubButtonBg: string;
    releaseNotesBg: string | undefined;
    checkUpdatesBorder: string;
    releaseNotesTextColor: string | undefined;
    logoUrl: string | undefined;
}

/** A control a section lets the settings search find by name. */
export interface SearchHit { label: string; path: string; run(): void }
export interface SearchProvider { pane: string; search(query: string): SearchHit[] | null | undefined }

/**
 * The one dialog contract every section relies on (built by ui-panel.ts).
 * Sections written for partial mounts (tests, admin pages) call the optional
 * members through `?.` exactly as the legacy modules did.
 */
export interface PanelContext extends PanelTheme {
    help: HTMLElement;
    pluginShortcuts: Shortcut[];
    resetAutoCloseTimer(): void;
    /** Register a teardown that runs when the panel closes (any path). */
    onClose(fn: () => void): void;
    /** Close the panel through its full teardown. */
    closePanel(): void;
    registerSearch(provider: SearchProvider): () => void;
    /** Show a pane by its data-pane slug; false when no such pane exists. */
    openPane(slug: string): boolean;
    createToast(featureKey: string, isEnabled: boolean): string;
}

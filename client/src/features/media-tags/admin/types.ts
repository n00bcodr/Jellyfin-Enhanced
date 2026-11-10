/**
 * @file The contract between the Media Tags admin tab (admin-tags.ts), its
 * section modules (sections/*.ts, each loaded as its own script) and the
 * configuration page: the declarative field and section definitions, the
 * page context a section draws with, and the `JE.adminTags` facade.
 */
import type { JsonValue } from '../../../contracts/generated';
import type { TagPreview } from '../settings/ui-panel-tag-preview';
import type { AdminTagLayout } from './host';
import type { Fmt, FmtParams, WordTables } from './format';
import type { Config } from './values';

/** Ownership of one running whole-document action; callers check after every await before an effect. */
export interface HeldSaveScope {
    isCurrent(): boolean;
    throwIfStale(): void;
}

export type FieldType = 'switch' | 'select' | 'number' | 'text' | 'textarea' | 'pills' | 'ordered' | 'enable' | 'custom';
/** An option: [value, label]; a label starting with "=" is shown as written. */
export type FieldOption = readonly [string, string];

/**
 * One declared field (one control). `id` is the control's DOM id, `key` the
 * PluginConfiguration field it reads and writes. See admin-tags.ts.
 */
export interface FieldDef {
    id: string;
    key: string;
    type: FieldType;
    label: string;
    desc?: string | undefined;
    descParams?: FmtParams | undefined;
    options?: readonly FieldOption[] | undefined;
    min?: number | undefined;
    max?: number | undefined;
    fallback?: JsonValue | undefined;
    unit?: string | undefined;
    pattern?: string | undefined;
    placeholder?: string | undefined;
    rows?: number | undefined;
    /** Never shown or sent as Expected (an API key). */
    secret?: boolean | undefined;
    /** A text field for a long value (a URL, a key, a list): the box keeps its full width. */
    wide?: boolean | undefined;
    /** A text field for a key: dots until hovered or focused, without type="password" (browsers would offer to save it). */
    mask?: boolean | undefined;
    master?: boolean | undefined;
    /** The section draws it with fieldHtml; the page still binds it. */
    place?: 'section' | undefined;
    /** Start a new box. */
    break?: boolean | undefined;
    /** Fields sharing a `more` key sit under one closed disclosure named by it. */
    more?: string | undefined;
    /** Ordered fields: the PluginConfiguration field their position writes. */
    orderKey?: string | undefined;
    defaultOrder?: number | undefined;
    /** Disabled unless true. */
    when?: ((config: Config) => boolean) | undefined;
    hideWhenOff?: boolean | undefined;
    /** Hidden unless true. */
    visible?: ((config: Config) => boolean) | undefined;
    read?: ((raw: JsonValue | undefined, config: Config) => JsonValue) | undefined;
    write?: ((value: JsonValue, config: Config) => JsonValue) | undefined;
    /** More fields to write with this one. */
    onChange?: ((value: JsonValue, config: Config) => Config | null | undefined) | undefined;
    /** Who the setting reaches ('new': each user's copy); filled in by the page when it draws the card. */
    scope?: 'new' | 'all' | undefined;
}

export const TAB_IDS = ['overview', 'layout', 'groups', 'rules', 'colours', 'badges', 'server'] as const;
export type TabId = typeof TAB_IDS[number];
export interface TabDef { id: TabId; icon: string; nameKey: string; shortKey?: string; descKey: string; lead?: 'card' }

/** A sample chip on a group row: [kind, text]; kind `flag` is a flag code, `icon` a symbol name. */
export type SampleChip = readonly [string, string];

/** A section of the tab (one card, a note, or a Groups row). */
export interface SectionDef {
    id: string;
    tab: TabId;
    order?: number | undefined;
    title: string;
    hint?: string | undefined;
    fields?: FieldDef[] | undefined;
    /** Fields its own editors write that are not declared above. */
    writes?: readonly string[] | undefined;
    group?: {
        id: string;
        summary?: ((ctx: PageContext) => string) | undefined;
        sample?: ((ctx: PageContext) => SampleChip[]) | undefined;
    } | undefined;
    /** An explanation with nothing to set: drawn as a closed disclosure. */
    note?: boolean | undefined;
    noteLabel?: string | undefined;
    render?: ((ctx: PageContext, body: HTMLElement) => void) | undefined;
    refresh?: ((ctx: PageContext, body: HTMLElement | null) => void) | undefined;
    load?: ((ctx: PageContext, body: HTMLElement | null) => void) | undefined;
    show?: ((ctx: PageContext, body: HTMLElement | null) => void) | undefined;
    dispose?: ((ctx: PageContext) => void) | undefined;
}

export interface Target { tab: string | null; group: string | null }
export type StoreState = 'saved' | 'saving' | 'error' | 'conflict';

export interface SetOptions {
    /** false keeps the controls as they are. */
    redraw?: boolean | undefined;
    /** Per-entry intent (TagLookItemOverrides); otherwise a replacement. */
    itemEdit?: boolean | undefined;
    /** What the server held for these fields (an import preview's from), compared and sent as Expected. */
    base?: Config | undefined;
}
export interface OpenTabOptions { group?: string | null | undefined; focus?: boolean | undefined; focusTab?: boolean | undefined }

/** The page context every section draws with. */
export interface PageContext {
    perUserMark(): string;
    root: HTMLElement;
    /** The working copy of the configuration. */
    config: Config;
    t: Fmt;
    tx(text: unknown, params?: FmtParams): string;
    esc(value: unknown): string;
    set(key: string, value: JsonValue): void;
    isCurrent(): boolean;
    setMany(values: Config, opts?: SetOptions): void;
    flush(): Promise<boolean>;
    refresh(opts?: { controls?: boolean }): void;
    reload(fresh: Config): void;
    openTab(id: string, opts?: OpenTabOptions): boolean;
    setGroupOpen(group: string, open: boolean, opts?: { focus?: boolean | undefined }): void;
    confirm(text: string, title: string): Promise<boolean>;
    snack(message: string, undo?: (() => void) | null, origin?: () => Element | null | undefined): void;
    announce(message: string): void;
    dispose(): void;
    pageUrl(tab?: string | null, group?: string | null): string;
    mainPageUrl(section?: string | null, tab?: string | null): string;
    currentTab(): string;
    pending(): boolean;
    readonly disposed: boolean;
    signal: AbortSignal;
    readonly preview: TagPreview | null;
    layout: AdminTagLayout | null;
    fieldValue(f: FieldDef, config: Config): JsonValue | undefined;
}

/** A page's host hooks (tests): read and patch the configuration, confirm. */
export interface PageApi {
    get(): Promise<unknown>;
    /** Rejects with {status: 409, json()} → {conflicts} when refused. */
    patch(changes: Config, expected: Config): Promise<unknown>;
}
export interface PageOptions {
    api?: PageApi | undefined;
    confirm?: ((text: string, title: string) => boolean | Promise<boolean>) | undefined;
    now?: (() => number) | undefined;
    target?: Target | undefined;
}

/** The Tag Styles editor (tag-styles-editor.ts). */
export interface TagStylesEditor {
    load(json: JsonValue | undefined, preset: JsonValue | undefined): void;
    serialize(): string;
    settings(): { preset: string };
    snapshot(): string;
    refreshLabels(): void;
}
export type CreateTagStylesEditor = (root: HTMLElement, customLabels?: () => string[], isCurrent?: () => boolean) => TagStylesEditor;
/** The contrast helpers of the Tag Styles editor (pure). */
export interface TagStyleContrast {
    rgbaOf(css: unknown): { r: number; g: number; b: number; a: number } | null;
    compositeOver(top: { r: number; g: number; b: number; a: number }, under: { r: number; g: number; b: number }): { r: number; g: number; b: number; a: number };
    luminance(c: { r: number; g: number; b: number }): number;
    contrastRatio(text: unknown, background: unknown): number | null;
    contrastLevel(ratio: number): { level: string; label: string };
}

/** A stored custom tag rule, as the server keeps it. */
export type CustomRule = { Match: string; Value: string; Label: string; Icon: string | null };
/** The Custom rules editor (custom-rules-editor.ts). */
export interface CustomRulesEditor {
    load(config: Config): void;
    collect(config: Config): void;
    labels(): string[];
    snapshot(): string;
    onLabelsChanged(fn: (() => void) | null): void;
}
export type CreateCustomRules = (root: ParentNode, onChange?: (rules: CustomRule[]) => void, isCurrent?: () => boolean) => CustomRulesEditor;

/** The core of the facade, installed by admin-tags.ts. */
export interface AdminTagsCore {
    fmt: Fmt;
    WORDS: WordTables;
    TABS: readonly TabDef[];
    SECTION_FILES: readonly string[];
    SEEDED_KEYS: readonly string[];
    MAIN_PAGE_NAME: string;
    TAB_ID: string;
    LEGACY_PAGE_NAME: string;
    PLUGIN_ID: string;
    sections: SectionDef[];
    registerSection(def: SectionDef): void;
    pageFields(): Set<string>;
    seedUser(config: Config): Config;
    pageUrl(tab?: string | null, group?: string | null): string;
    mainPageUrl(section?: string | null, tab?: string | null): string;
    fieldHtml(f: FieldDef, config: Config): string;
    fieldsHtml(fields: readonly FieldDef[] | undefined, config: Config): string;
    redrawList(list: Element, html: string, selectorOf: (el: HTMLElement) => string | null): void;
    fieldValue(f: FieldDef, config: Config): JsonValue | undefined;
    controlValue(f: FieldDef, el: Element, config: Config): JsonValue;
    createPage(root: HTMLElement, config: Config, options?: PageOptions): PageContext;
    mountTab(tab: HTMLElement, version?: string): Promise<PageContext | null>;
    activate(page: HTMLElement): Promise<PageContext | null>;
    holdSaves<T>(fn: (scope: HeldSaveScope) => Promise<T>): Promise<T>;
    current(): PageContext | null;
    requestedTarget(): Target;
    pendingState(): { state: StoreState; fields: string[]; failed: string[] };
    leaveWithPending(): Promise<void>;
}

/** Members the section and editor modules add to the facade when they load. */
export interface AdminTagsExtensions {
    EDITOR_HTML?: string;
    createTagStylesEditor?: CreateTagStylesEditor;
    tagStyleContrast?: TagStyleContrast;
    CUSTOM_HTML?: string;
    createCustomTagRules?: CreateCustomRules;
    GROUP_SWITCHES?: ReadonlyArray<readonly [string, string, string]>;
    cacheSummary?: (ctx: PageContext) => Promise<void>;
    rebuildCache?: (ctx: PageContext) => Promise<void>;
    ratingData?: { SOURCES: readonly string[]; selectedSources(c: Config): string[] };
    layoutData?: object;
    rulesData?: object;
}

/** `JE.adminTags`: the core once admin-tags.ts ran; the editors may create it partially when loaded on their own. */
export type AdminTagsFacade = Partial<AdminTagsCore> & AdminTagsExtensions;
export type AdminTagsApi = AdminTagsCore & AdminTagsExtensions;

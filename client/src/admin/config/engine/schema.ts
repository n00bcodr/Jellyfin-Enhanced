import type { AdminConfig, JsonValue } from '../domain/config';

export type Attributes = Readonly<Record<string, string | number | boolean>>;
/** A field's visibility condition: a toggle (or any non-empty field), or one exact value. */
export type ShowIf = string | { id: string; equals?: string | number | boolean };
/** A control's value in the page, before toConfig. */
export type UiValue = string | number | boolean;

interface FieldBase {
    id: string;
    prop?: string;
    label?: string;
    desc?: string | null;
    descClass?: string;
    main?: boolean;
    /** Users hold a personal copy (see ResetAllUsersSettings): a badge and an apply-to-all banner. */
    perUser?: boolean;
    showIf?: ShowIf;
    /** Rendered only: load and save stay in the page modules, so no prop is needed. */
    manual?: boolean;
    attrs?: Attributes;
    rowAttrs?: Attributes;
    descAttrs?: Attributes;
    rowClass?: string;
    placeholder?: string;
    fromConfig?(value: JsonValue | undefined, config: AdminConfig): UiValue;
}
export interface ToggleField extends FieldBase { type: 'toggle'; default?: boolean; toConfig?(value: boolean, config: AdminConfig): JsonValue }
export interface TextField extends FieldBase { type: 'text' | 'password'; default?: string; toConfig?(value: string, config: AdminConfig): JsonValue }
export interface TextareaField extends FieldBase { type: 'textarea'; default?: string; rows?: number; toConfig?(value: string, config: AdminConfig): JsonValue }
export interface NumberField extends FieldBase { type: 'number'; default?: number; min?: number; max?: number; step?: number; toConfig?(value: number, config: AdminConfig): JsonValue }
export interface SelectField extends FieldBase { type: 'select' | 'position'; default?: string | number; options: ReadonlyArray<readonly [string, string]>; toConfig?(value: string | number, config: AdminConfig): JsonValue }
export type FieldSpec = ToggleField | TextField | TextareaField | NumberField | SelectField;

interface MarkupBase { showIf?: ShowIf; id?: string }
export interface NoteItem extends MarkupBase { type: 'note'; html: string; tone?: 'info' | 'warn' }
export interface HtmlItem extends MarkupBase { type: 'html'; html: string }
export interface ButtonItem extends MarkupBase { type: 'button'; id: string; label: string; hint?: string; variant?: 'primary' | 'danger' }
export interface CustomItem extends MarkupBase { type: 'custom'; html: string; init?(root: Document): void }
export interface GroupItem extends MarkupBase { type: 'group'; title: string; open?: boolean; items: readonly SectionItem[] }
export type MarkupItem = NoteItem | HtmlItem | ButtonItem | CustomItem | GroupItem;
export type SectionItem = FieldSpec | MarkupItem;

interface SectionBase {
    id?: string | undefined;
    class?: string;
    attrs?: Attributes;
    icon?: string;
    iconImg?: string;
    title?: string;
}
/** `fields` is accepted as an alias of `items`. */
export interface OwnSection extends SectionBase { title: string; items?: readonly SectionItem[]; fields?: readonly SectionItem[]; mirrorOf?: undefined }
/** A linked copy of another section: same fields under suffixed ids, kept in step with the originals. */
export interface MirrorSection extends SectionBase { mirrorOf: string; title?: string; items?: readonly SectionItem[]; fields?: readonly SectionItem[] }
export type SectionSpec = OwnSection | MirrorSection;
export type SectionMap = Readonly<Record<string, SectionSpec>>;

/** Registers section definitions with the engine. */
export type DefineSections = (sections: SectionMap) => void;

const NON_FIELD: readonly string[] = ['note', 'html', 'button', 'custom', 'group'];
export function isField(item: SectionItem): item is FieldSpec {
    return !NON_FIELD.includes(item.type);
}

/** The same item with no field conversion: what a linked copy holds. */
export const MIRROR = '--mirror';

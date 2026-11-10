export type { ShortcutEntry } from '../domain/shortcuts';
import type { JsonValue } from '../domain/config';
import type { AlertOptions, MediaTagsContext } from '../../../host/admin-config-host';

export type { AlertOptions };
export type MediaTagsTabContext = MediaTagsContext;


export type { CustomTabsConfig, OwnedFlagUpdate } from '../domain/custom-tabs';
import type { OwnedFlagUpdate } from '../domain/custom-tabs';
export interface CustomTabsSyncResult { ok: boolean; status: 'noop' | 'ok' | 'skipped' | 'failed'; detail: string; ownedUpdates: OwnedFlagUpdate[] }

export type ArrType = 'sonarr' | 'radarr';
/** One stored Sonarr or Radarr instance; fields this page does not know are kept. */
export interface ArrInstance { Name?: string; Url?: string; ApiKey?: string; UrlMappings?: string; Enabled?: boolean; [extra: string]: JsonValue | undefined }

export type ElementAttributes = Readonly<Record<string, string | boolean | undefined>>;

export interface BrandingUpload {
    inputId: string;
    dropZoneId: string;
    statusId: string;
    fileName: string;
    previewId: string;
    placeholderId: string;
    deleteId: string;
    dimensionsId: string;
}

export type ConnectionStatus = 'ok' | 'error' | 'warn' | 'amber' | 'pending';
export interface ConnectionTestResult { status: ConnectionStatus; detail: string; at: number; generation?: number }

export interface WhatsNewSetting { id: string; tab: string; selector: string; title: string; version: string }
export type { MediaTagsPlace as MediaTagsLocation } from '../domain/whats-new';
export interface ChecklistRowState { state: ConnectionStatus; detail: string }

/** One banner line: a fieldset of the page, or a place on the Media Tags tab. */
export interface WhatsNewEntry {
    tab: string;
    tabLabel: string;
    title: string;
    selector?: string;
    href?: string;
    isWholeFieldset?: boolean;
    flashSelectors?: string[];
    mediaTags?: { section: string; group: string | null };
    ids?: string[];
}

export interface CustomTabsV12Hint { customId: string; nativeId: string; bannerId: string }
export interface SectionDep {
    tabSelector: string;
    checkFn: () => boolean;
    bannerIcon: string;
    bannerTitle: string;
    bannerHint: string;
    lockHint?: string;
    bannerId: string;
}
export interface IndividualDep { id: string; checkFn: () => boolean; hint: string; icon: string; label?: string; noHint?: boolean }
export interface ParentDep { parent: string; label: string; children: readonly string[]; anyOf?: readonly string[]; noHint?: boolean }
export interface MappingDef { id: string; service: string }
export interface BannerGroup { banners: readonly HTMLElement[]; trigger: HTMLElement; parentCheckbox: HTMLInputElement | null }

export interface ServiceUsage { remaining?: number | null; limit?: number | null; extra?: string; error?: string }
export interface ServiceCard {
    id: string;
    name: string;
    tab: string;
    icon?: string;
    iconImg?: string;
    state: string;
    detail: string;
    scrollTo?: string;
    ratio?: number | null;
    lastTested?: number;
}
export interface OverviewFeature { name: string; state: string; tab: string; detail: string }

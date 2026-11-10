import type { BookmarkDocumentResponse, BootstrapUserDocuments } from '../../contracts/generated';
import { client, type LoaderClient, type LoaderNamespace, type UserConfigView } from '../../host/bootstrap-pages-host';
import type { BootstrapClient } from './bootstrap-client';
import { sessionUnchanged } from './bootstrap-client';
import { currentUserId, hostAdministrator, requireObject, type IdentityScope } from './identity';
import { isRecord, toCamelCase } from './keys';
import { emptyUserConfig } from './namespace';

// Per-user document name → server file name. Object order is the userConfig key order.
const USER_CONFIG_DOCUMENTS = {
    settings: 'settings.json', shortcuts: 'shortcuts.json', bookmark: 'bookmark.json',
    elsewhere: 'elsewhere.json', hiddenContent: 'hidden-content.json'
} as const;
type DocumentName = keyof typeof USER_CONFIG_DOCUMENTS;
const DOCUMENT_NAMES = Object.keys(USER_CONFIG_DOCUMENTS) as DocumentName[];
const CAMEL_CASED: ReadonlySet<DocumentName> = new Set(['settings', 'bookmark', 'hiddenContent']);
const BOOKMARK_FIELDS = new Set(['ItemId', 'TmdbId', 'TvdbId', 'MediaType', 'Name', 'Timestamp', 'Label', 'CreatedAt', 'UpdatedAt', 'SyncedFrom', 'SeasonNumber', 'EpisodeNumber', 'Progress']);

/** A missing or failed document keeps its default; three are converted to camelCase. */
export function buildUserConfig(documents: Partial<Record<DocumentName, unknown>>): UserConfigView {
    const userConfig: UserConfigView = emptyUserConfig();
    for (const name of DOCUMENT_NAMES) {
        const value = documents[name];
        if (!isRecord(value)) continue;
        const converted = CAMEL_CASED.has(name) ? toCamelCase(value) : value;
        if (name === 'settings') userConfig.settings = requireObject(converted) ?? {};
        else userConfig[name] = converted;
    }
    return userConfig;
}

/**
 * Preserve dictionary identities verbatim. The generic recursive camel converter
 * changes uppercase record ids, so it must not process bookmark dictionaries.
 */
export function bookmarkSnapshotView(snapshot: BookmarkDocumentResponse | null | undefined, api: LoaderClient): Pick<UserConfigView, 'bookmark' | 'bookmarkRevision' | 'bookmarkBinding'> {
    if (!snapshot) return { bookmark: { bookmarks: {} }, bookmarkRevision: null };
    const document: unknown = JSON.parse(snapshot.Document);
    const fields = isRecord(document) ? document : {};
    const records = Object.entries(fields).find(([key]) => key.toLowerCase() === 'bookmarks')?.[1] ?? {};
    if (!isRecord(records) || Array.isArray(records)) throw new Error('Invalid bookmark records');
    const bookmarks = Object.fromEntries(Object.entries(records).map(([id, value]) => [id,
        isRecord(value) && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).map(([key, child]) => [BOOKMARK_FIELDS.has(key) ? key.charAt(0).toLowerCase() + key.slice(1) : key, child]))
            : value]));
    return {
        bookmark: { ...fields, bookmarks },
        bookmarkRevision: snapshot.Revision,
        bookmarkBinding: { client: api, userId: api.getCurrentUserId?.(), token: api.accessToken?.(), baseUrl: api.getUrl('/') }
    };
}

/** Build userConfig from the same five documents the standalone endpoints return. */
export function buildUserConfigFromBootstrap(documents: BootstrapUserDocuments): UserConfigView {
    return Object.assign(buildUserConfig({
        settings: documents.Settings, shortcuts: documents.Shortcuts, bookmark: documents.Bookmark,
        elsewhere: documents.Elsewhere, hiddenContent: documents.HiddenContent
    }), { settingsRevision: documents.SettingsRevision || null }, bookmarkSnapshotView(documents.BookmarkSnapshot, client()));
}

/** Fallback when bootstrap is unavailable. Null when the session changed during the requests. */
export async function fetchUserScopedConfig(userId: string, contracts: BootstrapClient, identity: IdentityScope): Promise<UserConfigView | null> {
    const api = client();
    const started = identity.key(api);
    const documents: Partial<Record<DocumentName, unknown>> = {};
    let settingsRevision: string | null = null;
    let bookmarkSnapshot: BookmarkDocumentResponse | null = null;
    const route = (name: DocumentName) => name === 'settings' ? 'settings-document'
        : name === 'bookmark' ? 'bookmark-document' : USER_CONFIG_DOCUMENTS[name];
    // Every fetch settles; a failure leaves that document at its default.
    await Promise.all(DOCUMENT_NAMES.map(name =>
        api.ajax({ type: 'GET', url: api.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${route(name)}?_=${Date.now()}`), dataType: 'json' })
            .then(async data => {
                if (name === 'settings') {
                    const [contract, hostUser] = await Promise.all([contracts.loadBootstrapContract(), api.getCurrentUser?.()]);
                    const snapshot = contract.parseSettingsDocument(data, hostAdministrator(hostUser, userId, 'Settings identity changed'));
                    documents[name] = snapshot.Settings;
                    settingsRevision = snapshot.Revision;
                } else if (name === 'bookmark') {
                    bookmarkSnapshot = (await contracts.loadBootstrapContract()).parseBookmarkDocument(data);
                } else documents[name] = data;
            })
            .catch(() => { documents[name] = null; })
    ));
    if (!sessionUnchanged(api, identity, started)) return null;
    return Object.assign(buildUserConfig(documents), { settingsRevision }, bookmarkSnapshotView(bookmarkSnapshot, api));
}

/** Seed the admin's default language without ever overwriting a user's own choice. */
export function seedDisplayLanguage(JE: LoaderNamespace, userId: string): void {
    if (!userId) return;
    const languageKey = `${userId}-language`;
    if (localStorage.getItem(languageKey) !== null) return;
    const desired = (JE.currentSettings?.displayLanguage || '').trim();
    if (!desired) return;
    const parts = desired.split('-');
    const normalized = parts.length === 1 ? (parts[0] ?? '').toLowerCase()
        : parts.length === 2 ? `${(parts[0] ?? '').toLowerCase()}-${(parts[1] ?? '').toUpperCase()}` : desired;
    localStorage.setItem(languageKey, normalized);
}

export const liveUserId = (): string | null => currentUserId(client());

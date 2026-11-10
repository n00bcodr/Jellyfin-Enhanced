import type { BootstrapResponse, RevisionedSettingsResponse, BookmarkDocumentResponse } from './generated';
import { bootstrapSchema } from './schema';
import { validateSchema } from './validate';

/** Accept only Jellyfin GUID identities, in either supported spelling. */
function normalizeUserId(value: string): string {
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value)) {
    throw new Error('Invalid bootstrap user identity');
  }
  return value.replace(/-/g, '').toLowerCase();
}

/** The schema is generated from the same DTO that the server actually returns. */
function isBootstrap(value: unknown): value is BootstrapResponse {
  return validateSchema(value, bootstrapSchema, bootstrapSchema.$defs);
}

/** Validate before application. Authorization expectations come from the host, never this payload. */
export function parseBootstrap(value: unknown, expectedUserId: string, isAdmin: boolean): BootstrapResponse {
  if (!isBootstrap(value)) throw new Error('Invalid bootstrap transport');
  if (!value.Version.trim()) throw new Error('Missing bootstrap version');
  if (normalizeUserId(value.UserId) !== normalizeUserId(expectedUserId)) throw new Error('Bootstrap response is for a different user');
  if (!isAdmin && value.PrivateConfig !== null) throw new Error('Private bootstrap config for a non-administrator');
  if (value.UserSettings.Settings !== null && value.UserSettings.Settings.IsAdmin !== isAdmin) {
    throw new Error('Bootstrap administrator identity mismatch');
  }
  if (value.UserSettings.BookmarkSnapshot != null) parseBookmarkDocument(value.UserSettings.BookmarkSnapshot);
  return value;
}

function isSettingsDocument(value: unknown): value is RevisionedSettingsResponse {
  return validateSchema(value, bootstrapSchema.$defs.RevisionedSettingsResponse, bootstrapSchema.$defs);
}
/** Fallback uses the same generated settings contract and caller authority as bootstrap. */
export function parseSettingsDocument(value: unknown, isAdmin: boolean): RevisionedSettingsResponse {
  if (!isSettingsDocument(value) || !value.Revision || value.Settings.IsAdmin !== isAdmin)
    throw new Error('Invalid settings transport or administrator identity');
  return value;
}

function isBookmarkDocument(value: unknown): value is BookmarkDocumentResponse {
  return validateSchema(value, bootstrapSchema.$defs.BookmarkDocumentResponse, bootstrapSchema.$defs);
}
export function parseBookmarkDocument(value: unknown): BookmarkDocumentResponse {
  if (!isBookmarkDocument(value) || !value.Revision) throw new Error('Invalid bookmark transport');
  const document: unknown = JSON.parse(value.Document);
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Invalid bookmark document');
  const maps = Object.entries(document).filter(([key]) => key.toLowerCase() === 'bookmarks');
  if (maps.length > 1) throw new Error('Ambiguous bookmark document');
  const records: unknown = maps[0]?.[1];
  if (maps.length && (!records || typeof records !== 'object' || Array.isArray(records))) throw new Error('Invalid bookmark records');
  return value;
}

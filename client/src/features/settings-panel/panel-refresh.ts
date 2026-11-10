/**
 * Whether a settings document fetched when the panel opens may replace the
 * loaded one. Saves are compare-and-swap on the loaded revision, so content
 * and revision must change together:
 * - the same revision as at the request means nothing changed: keep the
 *   loaded object (and any save queued from it);
 * - a revision that moved locally during the request (a save from this tab
 *   completed) means the loaded document is at least as new: keep it.
 * Only a document another tab or device changed replaces it, with its own
 * revision, so the panel's next save is not a spurious conflict.
 */
export function shouldApplyRefresh(startRevision: string | null | undefined, currentRevision: string | null | undefined, responseRevision: string): boolean {
    return responseRevision !== (startRevision ?? null) && (currentRevision ?? null) === (startRevision ?? null);
}

/** Elements that take text input, where '?' types rather than closes the panel. */
export function isTextEntryType(tag: string, type: string, editable: boolean): boolean {
    if (editable) return true;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'color'].includes(type);
}

/** The nav slug for a pane title without a data-pane attribute. */
export const paneSlug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

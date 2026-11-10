/**
 * @file The edits that are not on the server yet. They belong to the
 * document, not to one view: Jellyfin replaces the page element when the URL
 * changes, and an edit whose save failed must outlive that view until it is
 * retried. Every live view draws its save indicator from here. They also
 * belong to one administrator on one server: signing out, signing in as
 * someone else or switching servers drops them (resetSession), and work
 * started before that is ignored when it ends.
 *
 * Saves go through the page's host (POST JellyfinEnhanced/admin/configuration):
 * the server writes only the changed fields on top of what it holds, and
 * refuses (409) any field whose Expected value another administrator changed.
 */
import type { JsonValue } from '../../../contracts/generated';
import type { AdminTagLook } from './host';
import type { HeldSaveScope, PageApi, StoreState } from './types';
import { configOf, copy, objects, type Config, type JsonObject } from './values';

const ITEM_KEY = 'TagLookItemOverrides';

/** One server-wide item look edit: the look to keep (null removes it) and what the server held when the user acted. */
export interface ItemEdit { value: JsonValue; expected: JsonValue; acknowledge: boolean }
export interface StoreEvent { type: 'state' | 'saved'; values?: Config | undefined; theirs?: boolean | undefined }
export type StoreView = (event: StoreEvent) => void;
export interface SessionMark { generation: number; owner: string | null }

export interface StoreDeps {
    /** Opaque revision of the live account, server, client, credentials and root. */
    identity(): string;
    /** Whether a field is a secret (never sent as Expected). */
    isSecret(key: string): boolean;
    /** The look rules (core/tag-look.js), for server-wide item look edits. */
    tagLook(): AdminTagLook;
    /** The configuration page follows along (its Display card, the sidebar's unsaved mark). */
    announce(detail: { type: string; values: Config | null; state: StoreState }): void;
    /** The session ended: tear down the live view. */
    onReset(): void;
    /** A failed save's report. */
    reportSaveError(err: unknown): void;
    saveDelayMs: number;
}

/** The status and body of a definitive client rejection (4xx), when there is one. */
async function rejectionOf(err: unknown): Promise<{ conflicts: unknown; error: unknown } | null> {
    if (!err || typeof err !== 'object') return null;
    // As the page always compared it: a missing status is neither below 400 nor above 499.
    const status = Number(Reflect.get(err, 'status'));
    if (status < 400 || status >= 500) return null;
    try {
        const json: unknown = Reflect.get(err, 'json');
        const body: unknown = typeof json === 'function' ? await Reflect.apply(json, err, []) : err;
        return body && typeof body === 'object' ? { conflicts: Reflect.get(body, 'conflicts'), error: Reflect.get(body, 'error') } : null;
    } catch {
        return null;
    }
}

/** The status a rejected request carries, if any. */
const statusOf = (err: unknown): unknown => (err && typeof err === 'object' ? Reflect.get(err, 'status') : undefined);

/** The store's state. */
export interface StoreData {
    /** field → the value to save */
    values: Map<string, JsonValue>;
    /** field → the value read before it was edited (what the server should still hold) */
    base: Map<string, JsonValue>;
    /** field → another administrator's value that refused this edit */
    conflicts: Map<string, JsonValue>;
    state: StoreState;
    /** the fields the last failed save carried */
    failed: string[];
    timer: ReturnType<typeof setTimeout> | null;
    /** the save on its way */
    saving: Promise<boolean> | null;
    /** the newest view's host */
    host: PageApi | null;
    /** live views */
    views: Set<StoreView>;
    /** the server and administrator the edits belong to */
    owner: string | null;
    /** Per-id intent, captured at the edit boundary and retained across responses. */
    itemEdits: Map<string, ItemEdit>;
    itemMode: 'entries' | 'replace' | null;
    itemFlight: { value: JsonValue | undefined; edits: Map<string, ItemEdit> | null } | null;
    /** bumped by resetSession: requests from before it are ignored when they answer */
    generation: number;
    /** the configuration page's own Save on its way (holdSaves): field saves wait for it */
    hold: Promise<void> | null;
}

/** Creates the document-wide store (one per page load). */
export function createSaveStore(deps: StoreDeps) {
    const store: StoreData = {
        values: new Map(),
        base: new Map(),
        conflicts: new Map(),
        state: 'saved',
        failed: [],
        timer: null,
        saving: null,
        host: null,
        views: new Set(),
        owner: null,
        itemEdits: new Map(),
        itemMode: null,
        itemFlight: null,
        generation: 0,
        hold: null,
    };

    // Queue whole-document operations immediately, including during their first flush.
    let holdTail: Promise<void> | null = null;

    const clearTimer = () => {
        if (store.timer !== null) clearTimeout(store.timer);
        store.timer = null;
    };

    /** Tell every live view about a change of state or a completed save. */
    function notify(event: StoreEvent): void {
        for (const view of Array.from(store.views)) view(event);
        try {
            deps.announce({ type: event.type, values: event.values || null, state: store.state });
        } catch { /* no DOM events (tests without a document) */ }
    }

    function setState(state: StoreState): void {
        store.state = state;
        notify({ type: 'state' });
    }

    /**
     * Another administrator, no one, or another server: drop the previous
     * session's edits, timer and live view. Saves still on their way are
     * ignored when they answer; nothing is sent with the new credentials.
     */
    function resetSession(): void {
        store.generation++;
        clearTimer();
        store.saving = null;
        store.values.clear();
        store.base.clear();
        store.itemEdits.clear();
        store.itemMode = null;
        store.itemFlight = null;
        store.conflicts.clear();
        store.failed = [];
        store.host = null;
        store.owner = null;
        store.state = 'saved';
        store.hold = null;
        holdTail = null;
        deps.onReset();
        notify({ type: 'state' });
    }

    /** The edits belong to whoever is signed in now; anything else is dropped first. */
    function checkSession(): void {
        const now = deps.identity();
        if (store.owner !== null && store.owner !== now) resetSession();
        store.owner = now;
    }

    /** The session a request starts in, to compare with when it answers. */
    function sessionMark(): SessionMark {
        checkSession();
        return { generation: store.generation, owner: store.owner };
    }

    /**
     * Whether work started under `mark` still belongs to the signed-in session.
     * The ApiClient identity is reconciled first, so a server switch or sign-in
     * JE.session has not reported yet resets the session here and the old answer is dropped.
     */
    function sameSession(mark: SessionMark): boolean {
        checkSession();
        return mark.generation === store.generation && mark.owner === store.owner;
    }

    /** Whether some edit is not on the server yet (queued, on its way or failed). */
    const hasPending = (): boolean => store.values.size > 0 || !!store.saving || !!store.timer;

    /** The fields a reload must not replace: queued, on their way, failed or refused. */
    const protectedFields = (): Set<string> => new Set(store.values.keys());

    /** Apply only the user's pending item operations to a fresh server list. */
    function rebaseItemEdits(raw: JsonValue | undefined): JsonValue {
        const look = deps.tagLook();
        const looks = look.normalizeItemOverrides(raw);
        for (const [id, edit] of store.itemEdits) {
            if (edit.value) {
                const entry = look.normalizeItemOverrides([edit.value]).get(id);
                if (entry) looks.set(id, entry);
            } else looks.delete(id);
        }
        return copy(look.itemOverridesToWire(looks));
    }

    /** Serialize the captured per-entry intent, without diffing a later server snapshot. */
    function itemEditsMutation(edits: Map<string, ItemEdit>): JsonObject {
        return {
            Set: Array.from(edits.values()).filter((e) => e.value).map((e) => e.value),
            Remove: Array.from(edits).filter(([, e]) => !e.value).map(([id]) => id),
            Expected: Object.fromEntries(Array.from(edits, ([id, e]) => [id, e.expected])),
        };
    }

    /** The saved entries of TagLookItemOverrides by item id. */
    const entriesById = (saved: JsonValue | undefined): Map<string, JsonObject> => new Map(objects(saved).map((e) => [String(e.ItemId), e]));

    /**
     * Save every pending edit now. A failed save keeps its edits (state 'error')
     * for a retry from any view; a refused one waits for Keep mine / Take theirs
     * (state 'conflict') while the other fields still save.
     * @returns Whether everything pending so far is saved.
     */
    function flush(): Promise<boolean> {
        clearTimer();
        checkSession();
        // The configuration page's whole-document Save is on its way: save after it, on top of what it wrote.
        if (store.hold) {
            const hold = store.hold;
            const generation = store.generation;
            return hold.then(() => (generation === store.generation ? flush() : false));
        }
        if (store.saving) return store.saving.then((ok) => (ok && store.values.size ? flush() : ok));
        // A canceled entry edit succeeds locally; other fields still share one atomic patch.
        if (store.itemMode === 'entries' && !store.conflicts.has(ITEM_KEY)) {
            const look = deps.tagLook();
            for (const [id, edit] of store.itemEdits) {
                const delta = look.itemOverrideMutation(edit.expected ? [edit.expected] : null, edit.value ? [edit.value] : null);
                if (!edit.acknowledge && !delta.Set.length && !delta.Remove.length) store.itemEdits.delete(id);
            }
            if (!store.itemEdits.size) {
                const value = store.base.get(ITEM_KEY) ?? null;
                store.values.delete(ITEM_KEY);
                store.base.delete(ITEM_KEY);
                store.itemMode = null;
                notify({ type: 'saved', values: { [ITEM_KEY]: value } });
            }
        }
        const sent = new Map(Array.from(store.values).filter(([key]) => !store.conflicts.has(key)));
        if (!sent.size) {
            setState(store.conflicts.size ? 'conflict' : 'saved');
            return Promise.resolve(!store.conflicts.size);
        }
        const host = store.host;
        const mark: SessionMark = { generation: store.generation, owner: store.owner };
        // The values are snapshotted here and stay in the store until the server
        // took them: a reload meanwhile keeps them, and an edit made meanwhile is the next save's.
        const changes: Config = Object.fromEntries(sent);
        const expected: Config = {};
        const itemEdits = sent.has(ITEM_KEY) && store.itemMode === 'entries' ? new Map(store.itemEdits) : null;
        for (const key of sent.keys()) {
            const base = store.base.get(key);
            if (store.base.has(key) && base !== undefined && !deps.isSecret(key)) expected[key] = base;
        }
        if (sent.has(ITEM_KEY)) {
            if (itemEdits) {
                changes[ITEM_KEY] = itemEditsMutation(itemEdits);
                delete expected[ITEM_KEY];
            }
            store.itemFlight = { value: sent.get(ITEM_KEY), edits: itemEdits };
        }
        setState('saving');
        let refused = false;
        const saving = (async (): Promise<boolean> => {
            try {
                if (!host) throw new Error('No Media Tags page is open to save from');
                const result = await host.patch(changes, expected);
                // Signed out (or someone else signed in, or another server) meanwhile: not this session's any more.
                if (!sameSession(mark)) return false;
                const answered = result && typeof result === 'object' ? configOf(Reflect.get(result, 'values')) : null;
                if (!answered || Array.from(sent.keys()).some(key => !Object.prototype.hasOwnProperty.call(answered, key))) {
                    throw new Error('Media Tags save returned an incomplete acknowledgement');
                }
                const stored: Config = answered;
                const savedValue = (key: string): JsonValue | undefined => stored[key];
                for (const [key, value] of sent) {
                    const saved = savedValue(key);
                    if (store.values.has(key) && store.values.get(key) !== value) {
                        // Edited again meanwhile: the next save expects what this one stored.
                        store.base.set(key, copy(saved));
                        if (key === ITEM_KEY && store.itemMode === 'entries') {
                            const savedEntries = entriesById(saved);
                            for (const [id, edit] of itemEdits || []) {
                                const pending = store.itemEdits.get(id);
                                if (pending === edit) store.itemEdits.delete(id);
                                // Advance only our own acknowledged operation; remote entries
                                // keep the Expected stamp captured when the user acted.
                                else if (pending) store.itemEdits.set(id, { ...pending, expected: copy(savedEntries.get(id)) });
                            }
                            store.values.set(key, rebaseItemEdits(saved));
                        }
                    } else {
                        store.values.delete(key);
                        store.base.delete(key);
                        if (key === ITEM_KEY) { store.itemEdits.clear(); store.itemMode = null; }
                    }
                }
                store.failed = [];
                const values: Config = {};
                for (const key of sent.keys()) values[key] = savedValue(key);
                notify({ type: 'saved', values });
                return true;
            } catch (err) {
                const rejection = await rejectionOf(err);
                const rawConflicts = statusOf(err) === 409 ? configOf(rejection?.conflicts) : null;
                // Every refused key must belong to this request. Otherwise no pending
                // field is removed from the retry set and automatic flush never settles.
                const conflictKeys = Object.keys(rawConflicts || {});
                const conflicts = conflictKeys.length && conflictKeys.every(key => sent.has(key)) ? rawConflicts : null;
                const unwritten = (!!conflicts && Object.keys(conflicts).length > 0)
                    || (typeof rejection?.error === 'string' && rejection.error.includes(ITEM_KEY));
                if (!sameSession(mark)) return false;
                // Only a definitive rejection establishes that this request did not write.
                // Unknown outcomes retain the next intent and require acknowledgement,
                // even when a subsequent edit cancels its apparent delta.
                for (const [id, edit] of itemEdits || []) {
                    const pending = store.itemEdits.get(id);
                    if (!pending) continue;
                    if (!unwritten) store.itemEdits.set(id, { ...pending, acknowledge: true });
                    else if (pending !== edit) store.itemEdits.set(id, { ...pending, expected: edit.expected });
                }
                if (conflicts && Object.keys(conflicts).length) {
                    for (const [key, theirs] of Object.entries(conflicts)) store.conflicts.set(key, theirs ?? null);
                    refused = true;
                } else {
                    deps.reportSaveError(err);
                    store.failed = Array.from(sent.keys());
                }
                return false;
            } finally {
                if (mark.generation === store.generation) { store.saving = null; store.itemFlight = null; }
            }
        })();
        store.saving = saving;
        return saving.then((ok) => {
            if (!sameSession(mark)) return false;
            // Refused fields wait for a choice; the others in that request still save.
            if (refused) return flush();
            if (!ok) setState('error');
            else if (store.values.size) return flush();
            else setState(store.conflicts.size ? 'conflict' : 'saved');
            return ok && !store.conflicts.size;
        });
    }

    /**
     * Settle the fields another administrator changed: keep this page's values
     * (saved again over theirs) or take theirs.
     * @param mine
     * @returns Whether everything pending is saved afterwards.
     */
    function resolveConflicts(mine: boolean): Promise<boolean> {
        const theirs: Config = Object.fromEntries(store.conflicts);
        store.conflicts.clear();
        for (const [key, value] of Object.entries(theirs)) {
            if (mine) {
                store.base.set(key, copy(value));
                if (key === ITEM_KEY && store.itemMode === 'entries') {
                    const entries = entriesById(value);
                    for (const [id, edit] of store.itemEdits) store.itemEdits.set(id, { ...edit, expected: copy(entries.get(id)) });
                    store.values.set(key, rebaseItemEdits(value));
                }
            } else {
                store.values.delete(key);
                store.base.delete(key);
                if (key === ITEM_KEY) { store.itemEdits.clear(); store.itemMode = null; }
            }
        }
        if (!mine) notify({ type: 'saved', values: theirs, theirs: true });
        return flush();
    }

    /**
     * Run the configuration page's own Save (a whole-document write built from a
     * fresh read) so it cannot put an older Media Tags value back: edits not saved
     * yet are saved first, and field saves started meanwhile wait until it is done.
     * @param fn - The Save.
     */
    async function holdSaves<T>(fn: (scope: HeldSaveScope) => Promise<T>): Promise<T> {
        const mark = sessionMark();
        const previous = holdTail;
        let releaseQueue: () => void = () => {};
        const queued = new Promise<void>(resolve => { releaseQueue = resolve; });
        holdTail = queued;
        const requireOwner = () => {
            if (!sameSession(mark)) {
                const error = new Error('Media Tags action belongs to a previous session');
                error.name = 'AbortError';
                throw error;
            }
        };
        try {
            if (previous) await previous;
            requireOwner();
            if (hasPending()) {
                // Preserve failed/refused edits in the store for explicit recovery.
                try { await flush(); } catch { /* the edit stays pending */ }
                requireOwner();
            }
            let release: () => void = () => {};
            const hold = new Promise<void>(resolve => { release = resolve; });
            store.hold = hold;
            let active = true;
            const scope: HeldSaveScope = {
                isCurrent: () => active && sameSession(mark),
                throwIfStale: () => {
                    if (!active) {
                        const error = new Error('Media Tags action has already finished');
                        error.name = 'AbortError';
                        throw error;
                    }
                    requireOwner();
                },
            };
            try {
                return await fn(scope);
            } finally {
                active = false;
                if (store.hold === hold) store.hold = null;
                release();
            }
        } finally {
            if (holdTail === queued) holdTail = null;
            releaseQueue();
        }
    }

    /** Queue a save after a short pause (a burst of changes saves once). */
    function schedule(): void {
        clearTimer();
        setState('saving');
        store.timer = setTimeout(() => {
            store.timer = null;
            void flush();
        }, deps.saveDelayMs);
    }

    /**
     * Record an edit of TagLookItemOverrides: per-entry intent (itemEdit) folds into
     * the per-id edits; anything else replaces the whole list until acknowledged.
     * @param before - The page's value before the edit.
     * @param value - The new list.
     * @param itemEdit
     */
    function recordItemEdit(before: JsonValue | undefined, value: JsonValue, itemEdit: boolean): void {
        // Until the whole list is acknowledged, entry edits fold into that
        // replacement, including while its request is pending or failed.
        const replacing = store.itemMode === 'replace';
        if (itemEdit && !replacing) {
            const delta = deps.tagLook().itemOverrideMutation(before, value);
            const sets = new Map(delta.Set.map((e) => [e.ItemId, e]));
            for (const id of Object.keys(delta.Expected)) {
                const previous = store.itemEdits.get(id);
                const inFlight = !!previous && store.itemFlight?.edits?.get(id) === previous;
                store.itemEdits.set(id, { value: copy(sets.get(id)), expected: previous && !inFlight ? previous.expected : copy(delta.Expected[id]), acknowledge: !!previous?.acknowledge });
            }
            store.itemMode = 'entries';
        } else {
            store.itemEdits.clear();
            store.itemMode = 'replace';
        }
    }

    return {
        store, notify, setState, resetSession, checkSession, sessionMark, sameSession,
        hasPending, protectedFields, flush, resolveConflicts, holdSaves, schedule, recordItemEdit,
    };
}
export type SaveStore = ReturnType<typeof createSaveStore>;

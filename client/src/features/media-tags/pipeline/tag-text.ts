import { isRecord, own, type JsonRecord } from './dto';

// ── Tag text ────────────────────────────────────────────────────────
// The text an administrator set instead of a tag's own, from the public
// configuration's TagTextOverrides (JSON {"status":{"seasonFinale":"End of
// Season"}}), keyed by the Tag Styles label that colours the chip. The
// layout (layout/present.ts) applies it to quality, genre, status and awards
// chips. Mirrors TagTextRules / TagTextSet (server), which native posters use.
export interface TagText {
    /** The text for chips of this Tag Styles label, or null to keep their own. */
    of(group: string, label: unknown): string | null;
}

/** @param plugin - The public configuration, read at call time (it is replaced when settings are saved). */
export function createTagText(plugin: () => JsonRecord | undefined): TagText {
    let memo: { doc: unknown; map: Record<string, unknown> } = { doc: undefined, map: {} };
    return {
        of(group, label) {
            const doc = plugin()?.TagTextOverrides;
            if (memo.doc !== doc) {
                let map: unknown = {};
                try { map = typeof doc === 'string' && doc ? JSON.parse(doc) : {}; } catch { /* a bad document overrides nothing */ }
                memo = { doc, map: isRecord(map) ? map : {} };
            }
            if (label === null || label === undefined) return null;
            const labels = own(memo.map, group);
            const text = isRecord(labels) ? own(labels, String(label)) : null;
            return typeof text === 'string' && text ? text : null;
        },
    };
}

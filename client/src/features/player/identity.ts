export function getCurrentVideoItemId() {
        try {
            const hash = window.location.hash || '';
            const q = hash.indexOf('?');
            if (q === -1) return null;
            return new URLSearchParams(hash.substring(q + 1)).get('id');
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step item id parse failed', err);
            return null;
        }
    }

export function normalizeItemId(value: string | null | undefined) {
        const v = (value || '').replace(/-/g, '').toLowerCase();
        return v || null;
    }

export function parseItemIdFromVideosSrc(src: string) {
        const m = (src || '').match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
        return m?.[1] ?? null;
    }

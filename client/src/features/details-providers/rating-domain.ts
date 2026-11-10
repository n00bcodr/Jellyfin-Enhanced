/** Official-rating normalization shared by the details rating box and poster badges. */
const RATING_MAPPINGS: Readonly<Record<string, string>> = {
    'NOT RATED': 'NR',
    'NOT-RATED': 'NR',
    'UNRATED': 'NR',
    'NO RATING': 'NR',
    'DE-0': 'FSK-0',
    'DE-6': 'FSK-6',
    'DE-12': 'FSK-12',
    'DE-16': 'FSK-16',
    'DE-18': 'FSK-18',
    'FSK0': 'FSK-0',
    'FSK6': 'FSK-6',
    'FSK12': 'FSK-12',
    'FSK16': 'FSK-16',
    'FSK18': 'FSK-18',
    'FSK 0': 'FSK-0',
    'FSK 6': 'FSK-6',
    'FSK 12': 'FSK-12',
    'FSK 16': 'FSK-16',
    'FSK 18': 'FSK-18',
    'APPROVED': 'APPROVED',
    'PASSED': 'PASSED'
};
/** The `[rating=...]` colour key for an official rating text. */
export function normalizeRating(rating: string): string {
    if (!rating) return '';
    const normalized = rating.replace(/\s+/g, ' ').trim().toUpperCase();
    const mapped = Object.prototype.hasOwnProperty.call(RATING_MAPPINGS, normalized) ? RATING_MAPPINGS[normalized] : undefined;
    return mapped || rating.trim();
}

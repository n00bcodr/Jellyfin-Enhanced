/** The stored action of two maintenance check boxes. */
export function maintenanceAction(accounts: boolean, remote: boolean): 'both' | 'disable_accounts' | 'disable_remote' | 'none' {
    return accounts && remote ? 'both' : accounts ? 'disable_accounts' : remote ? 'disable_remote' : 'none';
}

/** The stored trigger of the two auto-request check boxes; nothing selected falls back to minutes watched. */
export function autoMovieTrigger(onStart: boolean, onMinutes: boolean): 'Both' | 'OnStart' | 'OnMinutesWatched' {
    return onStart && onMinutes ? 'Both' : onStart ? 'OnStart' : 'OnMinutesWatched';
}

/** The non-empty trimmed lines of a text box. */
export function lines(value: string): string[] {
    return (value || '').split('\n').map(line => line.trim()).filter(Boolean);
}

/** Split lines into http(s) URLs and everything else. */
export function httpUrls(values: readonly string[]): { valid: string[]; invalid: string[] } {
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const line of values) {
        try {
            const url = new URL(line);
            (url.protocol === 'http:' || url.protocol === 'https:' ? valid : invalid).push(line);
        } catch {
            invalid.push(line);
        }
    }
    return { valid, invalid };
}

/** A whole number within bounds; a blank or too-small value takes the fallback. */
export function clampedInt(raw: string, fallback: number, minimum: number, maximum: number): number {
    const value = parseInt(raw, 10);
    return isNaN(value) || value < minimum ? fallback : Math.min(value, maximum);
}

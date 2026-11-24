/**
 * Whether a keydown means Back: Escape, a browser Back key, or the Back button of a Samsung (10009) or
 * LG (461) remote. A TV shell can send a key event that is not a KeyboardEvent, so both fields are read
 * defensively.
 */
export function isTvBackKey(event: Event): boolean {
    const key = 'key' in event ? event.key : undefined;
    const code = 'keyCode' in event ? event.keyCode : undefined;
    return key === 'Escape' || key === 'BrowserBack' || key === 'GoBack' || code === 10009 || code === 461;
}

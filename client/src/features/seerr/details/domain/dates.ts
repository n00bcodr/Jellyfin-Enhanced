/** TMDB dates name a calendar day. Reading them as instants moved them across midnight. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const LONG_DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };

/** Whether a string starts with an ISO date (YYYY-MM-DD). */
export function isIsoDate(value: string): boolean {
    return ISO_DATE.test(value);
}

/** The year a date string names, or undefined when it names none. */
export function calendarYear(value: string): number | undefined {
    if (isIsoDate(value)) return Number(value.slice(0, 4));
    const year = new Date(value).getFullYear();
    return Number.isNaN(year) ? undefined : year;
}

/** "March 31, 1999" for the day a date string names, or undefined when it names none. */
export function longDate(value: string): string | undefined {
    const iso = isIsoDate(value);
    const date = new Date(iso ? `${value.slice(0, 10)}T00:00:00Z` : value);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toLocaleDateString('en-US', iso ? { ...LONG_DATE, timeZone: 'UTC' } : LONG_DATE);
}

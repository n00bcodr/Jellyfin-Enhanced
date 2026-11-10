import { isRecord, record } from '../../pipeline/dto';

export interface CalendarDate { y: number; m: number; d: number }
/** Item-independent facts; absent fields are unknown. */
export interface PersonFacts { birthDate?: string | undefined; deathDate?: string | undefined; birthPlace?: string | undefined }
/** One persisted person: birth date, death date, place, fetch time. */
export interface StoredPerson { ts: number; b?: string; d?: string; p?: string }
export interface PersonView {
    birthPlace: string | null;
    isDeceased: boolean;
    currentAge: number | null;
    ageAtDeath: number | null;
    ageAtItemRelease: number | null;
}

// ── Person facts model (pure) ──────────────────────────────────────────
// The cache holds item-independent facts per person; every age is
// derived at render time with the server's CalculateAge semantics, so a
// series' recurring cast is fetched once and shared by all episodes.
// "Today" is the browser's local date (the server used its own clock), so
// values can differ by a day around midnight across timezones; that is
// acceptable, and more current than the previous 30-day cached value.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
const PERSON_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_BIRTHPLACE_LENGTH = 300;

function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
    return month === 2 ? (isLeapYear(year) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}

/**
 * Parse the calendar date of 'yyyy-MM-dd' (optionally followed by a time
 * part, e.g. a Jellyfin PremiereDate) without any timezone conversion.
 * */
export function parseCalendarDate(value: unknown): CalendarDate | null {
    if (typeof value !== 'string') return null;
    const match = DATE_PATTERN.exec(value);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return { y, m, d };
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
    return (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
}

/**
 * Same result as the server's CalculateAge(birthDate, referenceDate):
 * year difference, minus one if the reference falls before that year's
 * anniversary (DateTime.AddYears moves Feb 29 to Feb 28 in non-leap
 * years), never below zero.
 * */
export function calculateAge(birth: CalendarDate, reference: CalendarDate): number {
    let age = reference.y - birth.y;
    const anniversary = { y: reference.y, m: birth.m, d: Math.min(birth.d, daysInMonth(reference.y, birth.m)) };
    if (compareDates(reference, anniversary) < 0) age--;
    return Math.max(0, age);
}

/**
 * @returns Local calendar date.
 */
export function todayDate(now: Date = new Date()): CalendarDate {
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

/**
 * Item-independent facts from a people/info (or person/{id}) response.
 * */
export function factsFromResponse(data: unknown): PersonFacts | null {
    if (!isRecord(data)) return null;
    const facts: PersonFacts = {};
    if (parseCalendarDate(data.birthDate)) facts.birthDate = String(data.birthDate).slice(0, 10);
    if (parseCalendarDate(data.deathDate)) facts.deathDate = String(data.deathDate).slice(0, 10);
    if (typeof data.birthPlace === 'string' && data.birthPlace.trim()) {
        facts.birthPlace = data.birthPlace.trim().slice(0, MAX_BIRTHPLACE_LENGTH);
    }
    return facts;
}

/**
 * Derive what a card shows, mirroring the server's person response.
 * @param premiere - Item premiere date (visible items only)
 */
export function describePerson(facts: PersonFacts, premiere: CalendarDate | null, today: CalendarDate): PersonView {
    const birth = parseCalendarDate(facts.birthDate);
    const death = parseCalendarDate(facts.deathDate);
    // Server: EndDate < DateTime.Now, i.e. the death date is today or earlier.
    const isDeceased = !!death && compareDates(death, today) <= 0;
    let currentAge: number | null = null;
    let ageAtDeath: number | null = null;
    let ageAtItemRelease: number | null = null;
    if (birth) {
        if (death && isDeceased) ageAtDeath = calculateAge(birth, death);
        else currentAge = calculateAge(birth, today);
        if (premiere) ageAtItemRelease = calculateAge(birth, premiere);
    }
    return { birthPlace: facts.birthPlace || null, isDeceased, currentAge, ageAtDeath, ageAtItemRelease };
}

/**
 * Validate one persisted entry { b, d, p, ts }; null if invalid/expired.
 */
export function sanitizeEntry(id: string, entry: unknown, now: number, ttlMs: number): StoredPerson | null {
    if (!PERSON_ID_PATTERN.test(id) || !isRecord(entry)) return null;
    const ts = entry.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || now - ts >= ttlMs || ts > now + 86400000) return null;
    const clean: StoredPerson = { ts };
    for (const field of ['b', 'd'] as const) {
        const value = entry[field];
        if (value === undefined) continue;
        if (typeof value !== 'string' || value.length !== 10 || !parseCalendarDate(value)) return null;
        clean[field] = value;
    }
    if (entry.p !== undefined) {
        if (typeof entry.p !== 'string' || !entry.p || entry.p.length > MAX_BIRTHPLACE_LENGTH) return null;
        clean.p = entry.p;
    }
    return clean;
}

/**
 * Keep at most maxEntries, dropping the oldest (by fetch time).
 * @returns True if anything was evicted.
 */
export function evictOldest(people: Map<string, StoredPerson>, maxEntries: number): boolean {
    if (people.size <= maxEntries) return false;
    const oldestFirst = [...people].sort((a, b) => a[1].ts - b[1].ts);
    for (const [id] of oldestFirst.slice(0, oldestFirst.length - maxEntries)) people.delete(id);
    return true;
}

/**
 * Parse and validate the persisted v2 store. A payload with another
 * owner, another version or a corrupt shape yields an empty store;
 * expired/invalid entries are dropped and the size is capped.
 * */
export function loadPeopleStore(raw: string | null | undefined, owner: string, now: number, ttlMs: number, maxEntries: number): { people: Map<string, StoredPerson>; rewrite: boolean } {
    const people = new Map<string, StoredPerson>();
    if (raw === null || raw === undefined) return { people, rewrite: false };
    let value: unknown = null;
    try {
        value = JSON.parse(raw);
    } catch {
        value = null;
    }
    const parsed = record(value);
    if (parsed.v !== 2 || parsed.owner !== owner || !isRecord(parsed.people)) {
        return { people, rewrite: true };
    }
    let rewrite = false;
    for (const [id, entry] of Object.entries(parsed.people)) {
        const clean = sanitizeEntry(id, entry, now, ttlMs);
        if (clean) people.set(id, clean);
        else rewrite = true;
    }
    if (evictOldest(people, maxEntries)) rewrite = true;
    return { people, rewrite };
}

export function serializePeopleStore(owner: string, people: ReadonlyMap<string, StoredPerson>): string {
    return JSON.stringify({ v: 2, owner, people: Object.fromEntries(people) });
}


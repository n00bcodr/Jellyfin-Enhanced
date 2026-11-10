import type {CalendarEvent, InstanceError} from './types';
export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(row: Record<string, unknown>, key: string): string | undefined {
 const value = row[key]; if (value == null) return undefined;
 if (typeof value !== 'string') throw new TypeError(`Invalid calendar ${key}`); return value;
}
function number(row: Record<string, unknown>, key: string): number | undefined {
 const value = row[key]; if (value == null) return undefined;
 if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid calendar ${key}`); return value;
}
function boolean(row: Record<string, unknown>, key: string): boolean | undefined {
 const value = row[key]; if (value == null) return undefined;
 if (typeof value !== 'boolean') throw new TypeError(`Invalid calendar ${key}`); return value;
}
/** Date-only releases are civil dates, never UTC midnight instants. */
export function releaseDate(value: string): Date {
 if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
  const [y = 0,m = 0,d = 0] = value.split('-').map(Number);
  const result = new Date(y,m-1,d);
  if (result.getFullYear() !== y || result.getMonth() !== m-1 || result.getDate() !== d) return new Date(NaN);
  return result;
 }
 return new Date(value);
}
export function dateKey(value: string): string {
 const date = releaseDate(value);
 return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function calendarResponse(value: unknown): {events: CalendarEvent[]; errors: InstanceError[]} {
 if (!record(value) || (!Array.isArray(value.events) && !Array.isArray(value.errors))) throw new TypeError('Invalid calendar response');
 if (value.events !== undefined && !Array.isArray(value.events)) throw new TypeError('Invalid calendar events');
 if (value.errors !== undefined && !Array.isArray(value.errors)) throw new TypeError('Invalid calendar errors');
 const events: CalendarEvent[] = [];
 for (const row of Array.isArray(value.events) ? value.events : []) {
  // Preserve baseline handling of absent/null records and undated releases.
  if (row === null || record(row) && row.releaseDate == null) continue;
  if (!record(row)) throw new TypeError('Invalid calendar event');
  const date = text(row,'releaseDate'), id = text(row,'id');
  if (!date || !id || !Number.isFinite(releaseDate(date).getTime())) throw new TypeError('Invalid calendar event identity/date');
  const also = row.alsoInInstances;
  if (also != null && (!Array.isArray(also) || !also.every((v: unknown) => typeof v === 'string'))) throw new TypeError('Invalid calendar instances');
  events.push({id, releaseDate: date, title: text(row,'title') ?? '',type: text(row,'type') ?? '', releaseType: text(row,'releaseType') ?? '',source: text(row,'source') ?? '',
   subtitle: text(row,'subtitle'),instanceName: text(row,'instanceName'),alsoInInstances: Array.isArray(also) ? also.filter((v: unknown): v is string => typeof v === 'string') : undefined,
   itemId: text(row,'itemId'),itemEpisodeId: text(row,'itemEpisodeId'),imdbId: text(row,'imdbId'),episodeImdbId: text(row,'episodeImdbId'),
   tvdbId: number(row,'tvdbId'),tmdbId: number(row,'tmdbId'),episodeTvdbId: number(row,'episodeTvdbId'),shokoSeriesId: number(row,'shokoSeriesId'),shokoEpisodeId: number(row,'shokoEpisodeId'),
   seasonNumber: number(row,'seasonNumber'),episodeNumber: number(row,'episodeNumber'),monitored: boolean(row,'monitored'),hasFile: boolean(row,'hasFile'),
   posterUrl: text(row,'posterUrl'),backdropUrl: text(row,'backdropUrl'),finaleType: text(row,'finaleType')});
 }
 const errors = (Array.isArray(value.errors) ? value.errors : []).map((row: unknown) => {
  if (!record(row)) throw new TypeError('Invalid calendar instance error');
  return {source: text(row,'source'),instanceName: text(row,'instanceName'),reason: text(row,'reason')};
 });
 return {events,errors};
}
export function userDataResponse(value: unknown) {
 if (!record(value) || !Array.isArray(value.results)) throw new TypeError('Invalid calendar user data');
 return value.results.map((row: unknown) => {
  if (!record(row) || typeof row.id !== 'string') throw new TypeError('Invalid calendar user data item');
  return {id:row.id,isFavorite:boolean(row,'isFavorite') ?? false,isWatched:boolean(row,'isWatched') ?? false};
 });
}
export function requestsResponse(value: unknown) {
 if (!record(value) || !Array.isArray(value.requests)) throw new TypeError('Invalid calendar requests');
 const totalPages = number(value,'totalPages') ?? 1;
 if (totalPages > 10000) throw new TypeError('Invalid calendar request pagination');
 const requests = value.requests.map((row: unknown) => {
  if (!record(row)) throw new TypeError('Invalid calendar request');
  return {type:text(row,'type') ?? '', tmdbId:number(row,'tmdbId')};
 });
 return {requests,totalPages};
}
export function savedFilters(value: unknown) {
 if (!record(value)) return null;
 return {filters:Array.isArray(value.filters) ? value.filters.filter((v: unknown): v is string => typeof v === 'string') : [],mode:value.mode === 'all' ? 'all' : 'any',invert:value.invert === true};
}

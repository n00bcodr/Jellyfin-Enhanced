/**
 * Pure response decoders and the session lease check shared by activity and catchup (review D2: they used to be
 * one copy in activity/host.ts and a verbatim copy in catchup, from step C3-catchup). Stateless: no module-level state, and each
 * function reads only its arguments, so inlining it into each IIFE output is harmless (frontend.md §2.2).
 */
/** The part of the session service a lease reads (activity's `SocialSession` satisfies it). */
export interface LeaseSession { getEpoch(): number; isCurrent(epoch: number): boolean }
/** The part of ApiClient a lease reads (activity's `SocialApi` satisfies it). */
export interface LeaseApi { getCurrentUserId(): string; getUrl(path: string): string }
export function currentLease(session: LeaseSession | undefined, getApi?: () => LeaseApi | undefined): () => boolean {
 const epoch = session?.getEpoch(), user = getApi?.()?.getCurrentUserId(), server = getApi?.()?.getUrl('/');
 return () => (epoch === undefined || session?.isCurrent(epoch) === true) && user === getApi?.()?.getCurrentUserId() && server === getApi?.()?.getUrl('/');
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function record(value: unknown): value is Record<string, unknown> {return typeof value === 'object' && value !== null && !Array.isArray(value);}
export function object(value: unknown): Record<string, unknown> {if (!record(value)) throw Error('Invalid response object'); return value;}
export function string(value: unknown): string {if (typeof value !== 'string') throw Error('Invalid response string'); return value;}
export function number(value: unknown): number {if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Invalid response number'); return value;}
export function optionalString(value: unknown): string | undefined {return value == null ? undefined : string(value);}
export function optionalNumber(value: unknown): number | undefined {return value == null ? undefined : number(value);}
export function optionalBoolean(value: unknown): boolean | undefined {if (value == null) return undefined; if (typeof value !== 'boolean') throw Error('Invalid response boolean'); return value;}
export function array<T>(value: unknown, decode: (value: unknown) => T): T[] {if (!Array.isArray(value)) throw Error('Invalid response array'); return value.map(decode);}

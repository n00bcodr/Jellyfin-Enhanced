/** JSON enters as unknown; a consumer earns its result type by decoding it. */
export type Decoder<T> = (value: unknown) => T;
export type Priority = 'low' | 'normal';
export interface ConcurrencyOptions { priority?: Priority; signal?: AbortSignal | null }
export interface RetryConfig {
    maxAttempts: number; baseDelayMs: number; maxDelayMs: number;
    jitterFactor: number; retryableStatuses: number[]; timeoutBudgetMs: number;
}
export interface ApiConfig {
    retry: RetryConfig;
    cache: { ttlMs: number; maxEntries: number };
    concurrency: { maxConcurrent: number; maxQueueSize: number; maxLowConcurrent: number; maxLowQueueSize: number };
}
export interface RequestOptions {
    method?: string; headers?: Record<string, string>; body?: unknown;
    signal?: AbortSignal; cacheKey?: string; skipCache?: boolean; skipRetry?: boolean;
    auth?: boolean; timeoutMs?: number; priority?: Priority;
    /** Opt in only when the endpoint guarantees replay safety. Writes default to one attempt. */
    retrySafe?: boolean;
}
export interface IdentityLease {
    readonly signal: AbortSignal;
    readonly headers: Readonly<Record<string, string>>;
    resolve(path: string): string;
    throwIfStale(): void;
}
export interface ApiDependencies {
    acquireLease(): IdentityLease;
    onIdentityChange(callback: () => void): void;
    onNavigate(callback: () => void): void;
    fetch(url: string, options: RequestInit): Promise<Response>;
    controller(): AbortController;
    combineSignals(signals: AbortSignal[]): AbortSignal;
    now(): number;
    wallNow(): number;
    random(): number;
    setTimer(callback: () => void, ms: number): number;
    clearTimer(timer: number): void;
    clone<T>(value: T): T;
    debug(...values: unknown[]): void;
}
export function abortError(): Error {
    const error = new Error('Request aborted'); error.name = 'AbortError'; return error;
}
export function isAbort(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}
export class HttpError extends Error {
    override readonly name = 'HttpError';
    responseText?: string;
    responseJSON?: unknown;
    constructor(readonly status: number) { super(`HTTP ${status}`); }
}
/** A failed write may have reached the server; automatic replay could duplicate it. */
export class MutationUncertainError extends Error {
    override readonly name = 'MutationUncertainError';
    constructor(readonly cause: unknown) { super('Mutation outcome is unknown; verify the server state before retrying'); }
}
export class DecodeError extends Error {
    override readonly name = 'DecodeError';
    constructor(readonly cause: unknown) { super('Response did not match the expected payload'); }
}

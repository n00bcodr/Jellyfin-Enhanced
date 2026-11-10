import { abortable, cancellation } from './cancellation';
import { abortError, HttpError, isAbort, MutationUncertainError, type ApiDependencies, type IdentityLease, type RetryConfig } from './types';
export interface RequestMetric { url: string; attempt: number; status: number; duration: number }
/** Pure backoff calculation; randomness is supplied by the host/test. */
export function backoff(attempt: number, config: RetryConfig, random: number): number {
    const delay = Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs);
    return Math.max(0, Math.round(delay + delay * config.jitterFactor * (random * 2 - 1)));
}
function sleep(deps: ApiDependencies, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(abortError()); return; }
        const abort = () => { deps.clearTimer(timer); reject(abortError()); };
        const timer = deps.setTimer(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}
/** Credentials/options are captured once. Every attempt must still own its identity lease. */
export async function retryFetch(deps: ApiDependencies, url: string, options: RequestInit,
    config: RetryConfig, lease: IdentityLease, record: (metric: RequestMetric) => void, retrySafe = false): Promise<Response> {
    const started = deps.now();
    const safe = retrySafe || ['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase());
    const attempts = safe ? Math.max(1, config.maxAttempts) : 1;
    const cancel = cancellation(deps, [lease.signal, options.signal], config.timeoutBudgetMs);
    const init: RequestInit = { ...options, signal: cancel.signal };
    let lastError: unknown = new Error('No request attempts');
    try {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            lease.throwIfStale();
            if (cancel.signal.aborted) throw abortError();
            if (deps.now() - started > config.timeoutBudgetMs) throw new Error(`Time budget exceeded (${config.timeoutBudgetMs}ms)`);
            try {
                const response = await abortable(deps.fetch(url, init), cancel.signal);
                lease.throwIfStale();
                if (response.ok) {
                    record({ url, attempt, status: response.status, duration: deps.now() - started });
                    return response;
                }
                const error = new HttpError(response.status);
                try {
                    const text = await abortable(response.clone().text(), cancel.signal);
                    if (text) {
                        error.responseText = text;
                        try { const data: unknown = JSON.parse(text); error.responseJSON = data; }
                        catch (parseError) { deps.debug('Error body not JSON:', parseError); }
                    }
                } catch (readError) { if (isAbort(readError)) throw readError; deps.debug('Failed to read error body:', readError); }
                lease.throwIfStale();
                lastError = error;
                if (!config.retryableStatuses.includes(response.status) || !safe) throw error;
            } catch (error) {
                lease.throwIfStale();
                if (isAbort(error)) throw error;
                if (error instanceof HttpError && (!config.retryableStatuses.includes(error.status) || !safe)) throw error;
                if (!safe) throw new MutationUncertainError(error);
                lastError = error;
            }
            if (attempt < attempts) await sleep(deps, backoff(attempt, config, deps.random()), cancel.signal);
        }
        throw lastError;
    } finally { cancel.dispose(); }
}

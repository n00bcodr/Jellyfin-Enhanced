import { isObject, type JsonObject } from './config';

/** What a failed ApiClient or XHR-style request can tell the page. */
export interface RequestFailure {
    status?: number;
    message?: string;
    responseText?: string;
    /** The parsed error body, when one could be read. */
    body?: JsonObject;
}

interface FailureShape { status?: unknown; message?: unknown; responseText?: unknown; responseJSON?: unknown; response?: { text?: unknown } }

function isResponse(value: unknown): value is Response {
    return typeof Response === 'function' && value instanceof Response;
}

function shapeOf(error: unknown): FailureShape {
    return typeof error === 'object' && error !== null ? error : {};
}

/** Read the fields a rejected request may carry; anything else is left out. */
export function requestFailure(error: unknown): RequestFailure {
    const shape = shapeOf(error);
    const failure: RequestFailure = {};
    if (typeof shape.status === 'number') failure.status = shape.status;
    if (typeof shape.message === 'string') failure.message = shape.message;
    if (typeof shape.responseText === 'string') failure.responseText = shape.responseText;
    if (isObject(shape.responseJSON)) failure.body = shape.responseJSON;
    else {
        const textBody = failure.responseText ?? shape.response?.text;
        if (typeof textBody === 'string' && textBody.trim().charAt(0) === '{') {
            try {
                const parsed: unknown = JSON.parse(textBody);
                if (isObject(parsed)) failure.body = parsed;
            } catch {
                // Not JSON: the status alone describes the failure.
            }
        }
    }
    return failure;
}

/**
 * Jellyfin's ApiClient.ajax rejects with the Response object, which keeps its body behind an
 * asynchronous read. Reads it from a copy, so the typed code/cfRay/message envelope can be shown.
 */
export async function requestFailureWithBody(error: unknown): Promise<RequestFailure> {
    const failure = requestFailure(error);
    if (isResponse(error)) {
        try {
            const body: unknown = await error.clone().json();
            if (isObject(body)) failure.body = body;
        } catch {
            // Not JSON: the status alone describes the failure.
        }
    }
    return failure;
}

/** A failure's own message, or the fallback. */
export function failureMessage(error: unknown, fallback: string): string {
    return requestFailure(error).message || fallback;
}

/** A failure's message, its HTTP status, or the fallback; never "[object Response]". */
export function failureDescription(error: unknown, fallback: string): string {
    const failure = requestFailure(error);
    if (failure.message) return failure.message;
    if (!failure.status) return fallback;
    const statusText = isResponse(error) ? error.statusText : '';
    return 'HTTP ' + failure.status + (statusText ? ' ' + statusText : '');
}

/** Whether a rejection means the work was refused or cancelled, rather than failed. */
export function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

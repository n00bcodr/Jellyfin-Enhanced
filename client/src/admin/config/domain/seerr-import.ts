import { asObject, isObject, type JsonObject } from './config';

/**
 * POST jellyseerr/import-users: the answer may be the object itself, the same object as JSON text,
 * or either wrapped in `data`. Text that is not JSON reads as empty.
 */
export function importPayload(response: unknown): JsonObject {
    let payload = response;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            payload = {};
        }
    }
    const body = asObject(payload);
    return isObject(body.data) ? body.data : body;
}

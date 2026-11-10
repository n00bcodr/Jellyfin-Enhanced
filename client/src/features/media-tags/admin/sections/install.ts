/**
 * @file How a section module joins the tab: it runs only once admin-tags.js
 * installed the facade (a section loaded on its own does nothing, as before).
 */
import { adminBridge, adminTagsApi, type AdminTagsBridge } from '../host';
import type { JsonValue } from '../../../../contracts/generated';
import type { AdminTagsApi } from '../types';

/**
 * Run a section module's registration against the installed facade.
 * @param register - Receives the facade and the JE bridge.
 */
export function installSection(register: (A: AdminTagsApi, JE: AdminTagsBridge) => void): void {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
}

/**
 * A stored value as a summary shows it: `value || fallback`, as the legacy text read it.
 * @param value
 * @param fallback
 * @returns {string|number}
 */
export function shown(value: JsonValue | undefined, fallback: number): string | number {
    if (typeof value === 'number' || typeof value === 'string') return value || fallback;
    return value ? JSON.stringify(value) : fallback;
}

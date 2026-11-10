import { seerrCoreHost } from '../host-core';

// The frozen JE.requestManager alias of the shared core request manager (retry,
// dedup, concurrency and cache live in core/api-client.js, which owns the
// navigation-abort wiring as well).
const { JE } = seerrCoreHost();
const manager = JE.core?.api?.manager;
if (!manager) throw new Error('Seerr request manager loaded before the core API client');
JE.requestManager = manager;

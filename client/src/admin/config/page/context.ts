import type { AdminApiClient } from '../../../host/admin-config-host';
import type { AdminEngine, EngineDashboard } from '../engine/api';
import type { MountLifecycle } from '../engine/lifecycle';

/** What every module of one page view shares. */
export interface PageContext {
    pluginId: string;
    ApiClient: AdminApiClient;
    Dashboard: EngineDashboard;
    JEAdmin: AdminEngine;
    page: HTMLElement;
    form: HTMLFormElement;
    /** Releases what this view registered outside its own elements. */
    lifecycle: MountLifecycle;
}

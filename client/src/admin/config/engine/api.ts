import type { AdminConfig } from '../domain/config';
import type { AlertInput } from './dialogs';
import type { MountLifecycle } from './lifecycle';
import type { SectionMap, SectionSpec } from './schema';

export interface MountOptions {
    /** false renders the sections only (no sidebar, no event wiring): used to read the finished page offline. */
    shell?: boolean;
    /** Releases the mount's listeners, observers and timers; a later mount replaces an earlier one. */
    lifecycle?: MountLifecycle;
}

export interface DashboardSource {
    showLoadingMsg?(): void;
    hideLoadingMsg?(): void;
    processPluginConfigurationUpdateResult?(result?: unknown): void;
}

export interface EngineDashboard {
    showLoadingMsg(): void;
    hideLoadingMsg(): void;
    processPluginConfigurationUpdateResult(result?: unknown): void;
    alert(options: string | AlertInput): Promise<void>;
    confirm(message: string, title?: string, callback?: (accepted: boolean) => void): Promise<boolean>;
}

/** window.JEAdmin: the schema-driven settings engine. */
export interface AdminEngine {
    sections: Record<string, SectionSpec>;
    mountShell(): void;
    alert(options?: string | AlertInput): Promise<void>;
    confirm(message: string, title?: string, danger?: boolean): Promise<boolean>;
    dashboardShim(real?: DashboardSource): EngineDashboard;
    define(sections: SectionMap): void;
    mount(root?: ParentNode, options?: MountOptions): void;
    load(config: AdminConfig): void;
    collect(config: AdminConfig): AdminConfig;
    markApplied(): void;
    setPerUser(properties: readonly string[]): void;
}

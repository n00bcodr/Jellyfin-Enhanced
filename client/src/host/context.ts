/**
 * The platform services a feature may reach through host/ (frontend.md §2.3; feature-boundaries rule 1 allows
 * features to import this file). It declares, types only, the settings document and save options the core
 * settings service uses (features/settings/host.ts re-exports them) and `FeatureName`, and (step C2) the
 * `FeatureContext` a feature host hands its modules.
 */
import type { JsonValue } from '../contracts/generated';

/** A JSON document boundary retains fields supplied by later plugin versions. */
export type SettingsDocument = { [key: string]: JsonValue | undefined };

export interface SaveOptions {
    throwOnError?: boolean; beforeSave?(): void; onError?(error: unknown): void | Promise<void>; isCurrent?(): boolean;
    /** Notification lifetime may end before an originating document's rollback does. */
    notifyOnError?(): boolean;
}

/** The client features (`client/src/features/*`; PLAN.md canonical feature list, admin-tags folded into media-tags). */
export type FeatureName =
    | 'activity' | 'bookmarks' | 'calendar' | 'catchup' | 'chrome' | 'details-providers' | 'downloads'
    | 'hidden-content' | 'media-tags' | 'player' | 'seerr' | 'settings' | 'settings-panel' | 'shared' | 'spoiler-guard';

/**
 * What a feature's modules get from its host (frontend.md §2.3). Runtime property names on
 * `window.JellyfinEnhanced` do not change; only the typed access path does.
 * - `core`: the feature's typed view of `window.JellyfinEnhanced`. The injected process-wide members (`t`,
 *   `currentSettings`, `toast`, `session`, `core.*`, …) stay on it (frontend.md §3 C3 scope).
 * - `own`: this feature's own slots: the facades it publishes on `window.JellyfinEnhanced` and its owner-only
 *   `JE.internals` slots (tests/frontend/architecture/internals-owners.json). Each property reads and writes the
 *   same runtime object as before, on every access.
 * - `peer(name)`: another feature's published facade, read on each call (the peer's script may load later), typed
 *   by that feature's public-api.ts.
 */
export interface FeatureContext<Own extends object, Peers extends object = Record<never, never>, Core extends object = object> {
    readonly feature: FeatureName;
    readonly core: Core;
    readonly own: Own;
    peer<K extends keyof Peers & string>(name: K): Peers[K] | undefined;
}

/** Where each key of a feature's `own` lives. */
export interface OwnSlots<Own extends object> {
    /** Facades the feature publishes on `window.JellyfinEnhanced` (`core[key]`). */
    readonly facades?: readonly (keyof Own & string)[];
    /** Owner-only `JE.internals` slots (`internals()[key]`). */
    readonly internalSlots?: readonly (keyof Own & string)[];
    /**
     * The `JE.internals` object. Only the owner's host file may touch it (feature-boundaries rule 3), so the
     * feature host passes this accessor; it is called on every access to an internals slot.
     */
    readonly internalsObject?: () => object;
}

/** The `JE.core` slot that carries the one shared copy of {@link createFeatureContext} (see publishFeatureContext). */
export interface FeatureContextCore {
    featureContext?: typeof createFeatureContext;
}

/**
 * Build a feature's context around the typed bridge its host read from `window.JellyfinEnhanced`.
 *
 * The implementation. Feature hosts do not call it directly: they call {@link featureContext}, which delegates to the
 * one copy core/ui-kit.js publishes on `JE.core.featureContext`, so the ~100 feature outputs no longer each inline
 * this function (canopy K1). Only scripts that run outside the component bundle, before it (the pre-login splash
 * and login image), call it directly.
 */
export function createFeatureContext<Own extends object, Peers extends object = Record<never, never>, Core extends object = object>(
    feature: FeatureName, core: Core, slots: OwnSlots<Own>,
): FeatureContext<Own, Peers, Core> {
    const own = {} as Own;
    // Plain property reads and assignments, exactly what `JE.<key>` / `JE.internals.<key>` did before.
    const bind = (keys: readonly string[], target: () => object) => {
        for (const key of keys) {
            Object.defineProperty(own, key, {
                enumerable: true,
                get: () => (target() as Record<string, unknown>)[key],
                set: (value: unknown) => { (target() as Record<string, unknown>)[key] = value; },
            });
        }
    };
    bind(slots.facades ?? [], () => core);
    const internalsObject = slots.internalsObject;
    if (slots.internalSlots?.length) {
        if (!internalsObject) throw new Error(`${feature}: internal slots need the host's internalsObject accessor`);
        bind(slots.internalSlots, internalsObject);
    }
    return {
        feature,
        core,
        own,
        peer: name => (core as Record<string, unknown>)[name] as Peers[typeof name] | undefined,
    };
}

/**
 * Publish the shared implementation on `JE.core` once (canopy K1). core/ui-kit.js does this as its first statement,
 * and it loads before every feature script in js/component-scripts.json (bundle and per-file loader alike;
 * tests/client-build/feature-context.test.mjs checks the order). Non-enumerable, so it never shows up in a walk of
 * `JE.core`; an existing copy is kept.
 */
export function publishFeatureContext(core: FeatureContextCore): void {
    if (typeof core.featureContext === 'function') return;
    Object.defineProperty(core, 'featureContext', { value: createFeatureContext, configurable: true, writable: true, enumerable: false });
}

/**
 * Build a feature's context (frontend.md §2.3). Feature hosts call this with the `JE` bridge; it runs the shared
 * implementation published on `JE.core.featureContext` (publishFeatureContext) instead of a copy inlined into
 * every feature output.
 */
export function featureContext<Own extends object, Peers extends object = Record<never, never>, Core extends object = object>(
    feature: FeatureName, core: Core, slots: OwnSlots<Own>,
): FeatureContext<Own, Peers, Core> {
    const shared = (core as { core?: FeatureContextCore }).core?.featureContext;
    if (typeof shared !== 'function') {
        throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared<Own, Peers, Core>(feature, core, slots);
}

/**
 * Shared modules (canopy K1b). client/shared-modules.json names stateless modules that many component scripts used to
 * inline, each with the one component script that ships it: its *provider*, the first script in
 * js/component-scripts.json that uses it. The build (scripts/client/shared-modules.mjs) injects
 * `publishSharedModules({ id: namespace })` into the provider, ahead of its own code, and replaces the module in every
 * later script with a stub that reads the published namespace through {@link sharedModule} at load time. Source files
 * are unchanged; the module must hold no state (the build checks its whole runtime import closure), so one copy behaves
 * exactly like the inlined ones did.
 */
export interface SharedModulesCore {
    sharedModules?: Record<string, object | undefined>;
}

/**
 * Publish module namespaces on `JE.core.sharedModules` (non-enumerable, like featureContext; a null-prototype object
 * keyed by module id). An id that is already there keeps its existing copy. Without `window.JellyfinEnhanced` nothing is
 * published: the provider's own code reports that, and the consumers' stubs fail with sharedModule's error.
 */
export function publishSharedModules(modules: Record<string, object>): void {
    const JE = (window as { JellyfinEnhanced?: { core?: SharedModulesCore } }).JellyfinEnhanced;
    if (!JE) return;
    const core = JE.core ??= {};
    let registry = core.sharedModules;
    if (!registry) {
        registry = Object.create(null) as Record<string, object | undefined>;
        Object.defineProperty(core, 'sharedModules', { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ??= namespace;
}

/** A consumer stub's lookup of the namespace published for module `id` (its path under client/src, without .ts). */
export function sharedModule(id: string): Record<string, unknown> {
    const namespace = (window as { JellyfinEnhanced?: { core?: SharedModulesCore } }).JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace as Record<string, unknown>;
}

/** One export of a shared namespace; the stubs mark each call pure, so an export nobody imports costs nothing. */
export function sharedExport(namespace: Record<string, unknown>, name: string): unknown {
    return namespace[name];
}

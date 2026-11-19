import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from './harness.mjs';

/** The ordered component modules (js/component-scripts.json without its "//" notes). */
export const manifestModules = () => JSON.parse(readFileSync(resolve(jsRoot, 'component-scripts.json'), 'utf8'))
  .filter(entry => typeof entry === 'string' && !entry.trim().startsWith('//')).map(entry => entry.trim());

/** The raw "groups" array of js/component-groups.json. */
export const rawGroups = () => JSON.parse(readFileSync(resolve(jsRoot, 'component-groups.json'), 'utf8')).groups;

/**
 * Resolve the groups file against the manifest the way the loader (client/src/bootstrap/loader/group-loader.ts) and
 * ClientScriptBundle.cs do:
 * "core" first with every module no group lists, then the file's groups, modules in manifest order.
 * @param {string[]} manifest
 * @param {Array<{ id: string, after?: string[], modules: string[] }>} groups
 * @returns {Array<{ id: string, after: string[], scripts: string[] }>}
 */
export function resolveGroups(manifest = manifestModules(), groups = rawGroups()) {
  const position = new Map(manifest.map((path, index) => [path, index]));
  const owned = new Set(groups.flatMap(group => group.modules));
  return [
    { id: 'core', after: [], scripts: manifest.filter(path => !owned.has(path)) },
    ...groups.map(group => ({ id: group.id, after: (group.after || []).filter(id => id !== 'core'),
      scripts: [...group.modules].sort((a, b) => position.get(a) - position.get(b)) }))
  ];
}

/**
 * A group plus everything it must load after, in run order.
 * @param {Array<{ id: string, after: string[] }>} groups Resolved groups.
 * @param {string[]} ids
 * @returns {string[]}
 */
export function groupClosure(groups, ids) {
  const byId = new Map(groups.map(group => [group.id, group]));
  const wanted = new Set(['core']);
  const add = id => { if (!byId.has(id) || wanted.has(id)) return; wanted.add(id); byId.get(id).after.forEach(add); };
  ids.forEach(add);
  return groups.map(group => group.id).filter(id => wanted.has(id));
}

const isPlain = value => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  // Realm-independent: a plain object's prototype is some realm's Object.prototype.
  return proto === null || (Object.getPrototypeOf(proto) === null && !Array.isArray(value));
};

/**
 * Load modules, in the given order, into a fresh harness whose `window.JellyfinEnhanced` records
 * what each module reads from and writes to the JE namespace while its top level is evaluated
 * (not what its functions do when they are called later).
 *
 * For every module the result holds:
 *  - `reads`: path -> `{ defined, by }`: whether the first top-level read of `JE.<path>` found a
 *    value, and which module had last written it (`null` for the loader's own stubs);
 *  - `writes`: the paths it gave a new value;
 *  - `touched`: every path it assigned, including a namespace written back unchanged.
 * A read of a path the same module assigns afterwards while it was undefined is the
 * `JE.x = JE.x || {}` idiom, not a dependency, and is left out.
 *
 * Only plain objects and functions under JE are followed; Maps, DOM nodes, arrays and other
 * instances are handed over as they are.
 * @param {string[]} modules Paths relative to js/, in the order to evaluate them.
 * @param {{ pluginConfig?: object }} [options] `pluginConfig`: the public config the modules see (several
 *   modules return early at load time when their feature is off).
 * @returns {Promise<{ records: Map<string, { reads: Map<string, { defined: boolean, by: string|null }>, writes: Set<string>, touched: Set<string> }>, failures: string[] }>}
 */
export async function recordEvalReads(modules, { pluginConfig = {} } = {}) {
  const cdnUrl = (source, path) => `http://jellyfin.test/JellyfinEnhanced/cdn/${source}/${path}`;
  // The same stubs bootstrap-manifest.test.mjs gives: only what plugin.js provides before the component stage.
  const root = {
    pluginConfig, userConfig: {}, translations: {}, currentSettings: {}, state: { activeShortcuts: {} },
    t: key => key, icon: () => '', IconName: {}, escapeHtml: value => String(value ?? ''),
    cdn: { url: cdnUrl, selfhst: file => cdnUrl('selfhst', file), flagPng: code => cdnUrl('flagcdn', code), flagSvg: code => cdnUrl('flag-icons', code), font: name => `http://jellyfin.test/JellyfinEnhanced/fonts/${name}` }
  };
  const proxies = new WeakMap();
  const raws = new WeakMap();
  const writers = new Map();
  const records = new Map();
  let current = null;
  const unwrap = value => (value !== null && (typeof value === 'object' || typeof value === 'function') && raws.has(value) ? raws.get(value) : value);
  const noteWrite = path => { if (current) { records.get(current).writes.add(path); writers.set(path, current); } };
  const noteTouch = path => { if (current) records.get(current).touched.add(path); };
  const wrap = (value, path) => {
    if (!(typeof value === 'function' || isPlain(value))) return value;
    if (proxies.has(value)) return proxies.get(value);
    const proxy = new Proxy(value, {
      get(target, key) {
        const result = Reflect.get(target, key);
        if (typeof key !== 'string') return result;
        const child = path ? `${path}.${key}` : key;
        if (current && typeof target !== 'function') {
          const record = records.get(current);
          if (!record.reads.has(child)) record.reads.set(child, { defined: result !== undefined, by: writers.get(child) ?? null });
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        // A frozen property must be returned as it is (proxy invariant).
        if (descriptor && !descriptor.configurable && !descriptor.writable && 'value' in descriptor) return result;
        return wrap(result, child);
      },
      set(target, key, next) {
        const value = unwrap(next);
        if (typeof key === 'string') noteTouch(path ? `${path}.${key}` : key);
        // `JE.x = JE.x || {}` on a namespace that exists writes back what is there: not a new definition.
        if (typeof key === 'string' && !(Reflect.has(target, key) && Reflect.get(target, key) === value)) noteWrite(path ? `${path}.${key}` : key);
        return Reflect.set(target, key, value);
      },
      defineProperty(target, key, descriptor) {
        if (typeof key === 'string') noteWrite(path ? `${path}.${key}` : key);
        if (descriptor && 'value' in descriptor) descriptor = { ...descriptor, value: unwrap(descriptor.value) };
        return Reflect.defineProperty(target, key, descriptor);
      },
      apply(target, thisArg, args) { return Reflect.apply(target, thisArg, args); },
      construct(target, args, newTarget) { return Reflect.construct(target, args, newTarget === proxy ? target : newTarget); }
    });
    proxies.set(value, proxy);
    raws.set(proxy, value);
    return proxy;
  };
  const JE = wrap(root, '');
  // Nothing is provided on a module's behalf: in this tree a script reads the modules client/shared-modules.json
  // shares (and core/ui-kit.js's feature context) from the scripts that ran before it, so a group that runs
  // without the script that ships one fails to load here, as it would in the browser.
  const h = createHarness({ JE, featureContext: false, sharedModules: false, globals: { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } } });
  const failures = [];
  try {
    for (const path of modules) {
      records.set(path, { reads: new Map(), writes: new Set(), touched: new Set() });
      current = path;
      try { h.load(path); } catch (error) { failures.push(`${path}: ${error?.message ?? error}`); }
      current = null;
      const record = records.get(path);
      for (const [read, { defined }] of record.reads) if (!defined && record.writes.has(read)) record.reads.delete(read);
      // The harness itself looks at the shared-module registry before every load (helpers/feature-context.cjs), so
      // its presence says nothing about the module. A module that needs a shared module nobody published fails to
      // load, which is reported as a failure.
      record.reads.delete('core.sharedModules');
    }
    await new Promise(done => setTimeout(done, 50));
  } finally {
    try { h.close(); } catch (error) { failures.push(`teardown: ${error?.errors?.map(String).join('; ') ?? error}`); }
  }
  return { records, failures };
}

/**
 * A public config with every feature switched on: any key that reads as a switch (`...Enabled`,
 * `Show...`, `...UseNativeTab` and the like) answers true, everything else is absent. Modules
 * that stop at load time when their feature is off then run their whole top level.
 * @returns {object}
 */
export function everythingOnConfig() {
  return new Proxy({}, {
    get: (target, key) => (typeof key === 'string' && /(Enabled|Active)$|^(Show|Use)[A-Z]/.test(key) ? true : target[key]),
    has: (target, key) => typeof key === 'string' && /(Enabled|Active)$|^(Show|Use)[A-Z]/.test(key)
  });
}

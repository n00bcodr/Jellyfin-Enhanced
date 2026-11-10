// canopy K1: the shared featureContext (client/src/host/context.ts publishFeatureContext), compiled from source once
// per process. In production core/ui-kit.js publishes it on JE.core before any feature script runs. Tests that load
// feature scripts without that provider (the jsdom harness, Playwright specs with their own JE fixture) evaluate this
// script after setting window.JellyfinEnhanced: it publishes the same function on JE.core (creating JE.core if absent).
// CommonJS so both the ESM jsdom helpers and the CommonJS Playwright specs can use it.
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../../..');
let source;

/** The installer script's source text. */
function featureContextInstaller() {
  source ??= buildSync({
    absWorkingDir: root, bundle: true, write: false, format: 'iife', target: 'es2020', logLevel: 'silent',
    stdin: {
      resolveDir: root, sourcefile: 'je-test-feature-context.ts', loader: 'ts',
      contents: "import { publishFeatureContext } from './client/src/host/context';\n"
        + "const je = (window as { JellyfinEnhanced?: { core?: object } }).JellyfinEnhanced;\n"
        + "if (je) publishFeatureContext(je.core ??= {});\n",
    },
  }).outputFiles[0].text;
  return source;
}

// canopy K1b: client/shared-modules.json. Each listed module ships in one component script (its provider), which
// publishes it on JE.core.sharedModules; later scripts read that copy. Tests that load a consumer without its provider
// get the same module, compiled from source (the whole module, as the provider ships it), published the same way.
const { readFileSync } = require('node:fs');
const sharedManifest = JSON.parse(readFileSync(resolve(root, 'client/shared-modules.json'), 'utf8')).modules;
/** [{ id, source, provider }] with provider relative to js/, as harness.load() paths are. */
const sharedModules = Object.entries(sharedManifest).map(([source, provider]) => ({
  id: source.slice('client/src/'.length, -'.ts'.length), source, provider: provider.slice('js/'.length),
}));
const installers = new Map();

/** The installer script for these shared modules: each module's namespace, published on JE.core.sharedModules. */
function sharedModulesInstaller(modules = sharedModules) {
  const key = modules.map(module => module.id).join('\n');
  if (!installers.has(key)) {
    installers.set(key, buildSync({
      absWorkingDir: root, bundle: true, write: false, format: 'iife', target: 'es2020', logLevel: 'silent',
      stdin: {
        resolveDir: root, sourcefile: 'je-test-shared-modules.ts', loader: 'ts',
        contents: "import { publishSharedModules } from './client/src/host/context';\n"
          + modules.map((module, i) => `import * as shared${i} from './${module.source}';\n`).join('')
          + `publishSharedModules({ ${modules.map((module, i) => `${JSON.stringify(module.id)}: shared${i}`).join(', ')} });\n`,
      },
    }).outputFiles[0].text);
  }
  return installers.get(key);
}

// Feature modules (and shared feature hosts) carry the featureContext delegate, whose error names the slot.
const usesFeatureContext = code => code.includes('JE.core.featureContext is missing');

/**
 * Before running the component script js/`path` (its `source`) in a realm, publish there what its providers publish in
 * production and is not there yet: the shared modules its stubs read (their ids appear in `source`; a provider publishes
 * its own) and featureContext, if the script or one of those modules needs it. `run(code)` evaluates in that realm
 * (jsdom window.eval, vm.runInContext).
 * Fixtures may reuse one JE.core object across test realms; a module another realm published reads that realm's
 * window, so such copies are dropped first (in production there is one realm).
 */
function provideSharedRuntime(run, source, path, { featureContext = true, shared = true } = {}) {
  if (!run('typeof window.JellyfinEnhanced === "object" && window.JellyfinEnhanced !== null')) return;
  const own = run('Object.getPrototypeOf({})');
  const registry = run('window.JellyfinEnhanced.core && window.JellyfinEnhanced.core.sharedModules');
  if (registry) for (const id of Object.keys(registry)) if (Object.getPrototypeOf(registry[id]) !== own) delete registry[id];
  const missing = shared ? sharedModules.filter(module => module.provider !== path && !registry?.[module.id] && source.includes(JSON.stringify(module.id))) : [];
  const installer = missing.length ? sharedModulesInstaller(missing) : '';
  if (featureContext && (usesFeatureContext(source) || usesFeatureContext(installer))
    && !run('typeof (window.JellyfinEnhanced.core && window.JellyfinEnhanced.core.featureContext) === "function"')) {
    run(featureContextInstaller());
  }
  if (installer) run(installer);
}

/**
 * Playwright: publish featureContext and every shared module in `page` (after the spec has set
 * window.JellyfinEnhanced, before its feature scripts). A provider the spec also loads keeps these copies.
 */
async function provideFeatureContext(page) {
  await page.addScriptTag({ content: featureContextInstaller() });
  await page.addScriptTag({ content: sharedModulesInstaller() });
}

module.exports = { featureContextInstaller, provideFeatureContext, provideSharedRuntime, sharedModules, sharedModulesInstaller };

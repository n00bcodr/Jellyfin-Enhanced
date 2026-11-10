# Frontend build and validation

This is migration infrastructure for Jellyfin 12.x, not completion of the product
rewrite. Unmapped legacy JavaScript stays runnable. Only mapped production files
are replaced, and each feature owner must preserve behavior at that entry point.

## Prerequisites and commands

Use Node >=22.12, npm, .NET SDK 10, Python 3 and `flock` (util-linux). Install
locked JavaScript dependencies explicitly with `npm ci`. TypeScript **6.0.3** and
esbuild **0.28.2** are pinned; the builder rejects missing or mismatched versions.
Neither the client builder nor the .NET build hook downloads npm dependencies.

| Command | Purpose |
| --- | --- |
| `npm run contracts:generate` | Generate authoritative server transport types and runtime validation |
| `npm run contracts:check` | Fail if generated transport files differ from the server contract |
| `npm run client:typecheck` | Strictly check all `client/src/**/*.ts`, including unmapped modules |
| `npm run client:build` | Type-check, bundle mapped entries, write changed artifacts and provenance |
| `npm run client:check` | Type-check and rebuild in memory; fail on missing/stale artifacts without writes |
| `npm run test:client-build` | Run isolated build, manifest, freshness and failure tests |
| `npm run inventory:rewrite` / `inventory:rewrite:check` | Generate / verify the complete structural migration inventory |
| `npm run test:contract-boundary` | Prove contract regeneration recovers from DTO drift and broken client output while build/pack guards reject stale assets |
| `npm run verify:rewrite` | Contract/client freshness, migration inventory, build and contract-boundary tests, frontend suite and Jellyfin 12 backend suite |

The combined gate sets `DOTNET_PROCESSOR_COUNT=2` and takes `flock` on
`../je-v12-validation.lock` relative to the repo, which is
`/home/jake/projects/je-v12-validation.lock` on the Lenovo. Set
`JE_VALIDATION_LOCK` to choose a CI lock path. Do not wrap this command in another
flock on the same file. Run standalone heavy .NET commands under the shared lock
and with `DOTNET_PROCESSOR_COUNT=2` too.

`verify:rewrite` verifies committed artifacts instead of regenerating them first:
CI must detect drift, not repair it. Generate contracts, client outputs and the migration inventory before
running it. The separate `.github/workflows/rewrite-validation.yml` runs this gate
without changing the existing regression workflow. Browser/real-host, visual,
mutation, release and feature-parity validation remain separate required work;
this command does not establish complete product parity.

## Entry ownership and artifacts

Each owner adds a flat JSON manifest directly in `client/entries`, for example:

```json
{ "js/core/session.js": "client/src/core/session-entry.ts" }
```

The keys are relative to `Jellyfin.Plugin.JellyfinEnhanced/`; values are relative
to the repository. The schema is `client/entry-manifest.schema.json`. The builder
rejects malformed/empty manifests, duplicate JSON keys, duplicate outputs across
manifests, case-insensitive or flattened embedded-resource collisions, absolute
paths, traversal, path aliases, symlink paths, missing sources and declaration-file
entries. Nested manifest directories are rejected to prevent accidentally ignored
entries. Declaration files may support type checking but cannot be runtime entries. Output directory segments must be ASCII identifiers, and output filenames must have only the final `.js` dot (letters, digits, underscores and hyphens in the basename). This makes accepted names match the existing embedded-resource lookups and prevents accidental culture satellites.

Source uses ES modules under `client/src`; the browser artifacts are bundled
classic IIFEs targeting ES2020. Imports are bundled rather than exposing new
browser module globals. An outer IIFE scopes TypeScript's strict-mode directive,
preserving the existing single-IIFE loader contract and adjacent legacy scripts;
esbuild includes that wrapper in source-map offsets.
Every bundled input must be TypeScript under `client/src`;
untyped legacy scripts and external runtime dependencies cannot silently bypass
strict checking. Existing globals must be represented by explicit typed adapters.
TypeScript enforces `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, isolated modules and type-only
imports. Do not bypass errors with broad `any` or suppression comments.

Every build, check and typecheck also parses production `.ts` files under
`client/src` with TypeScript's AST/comment parser. Explicit `any` type nodes and
compiler-recognized `@ts-nocheck`, `@ts-ignore`, or `@ts-expect-error` directives
fail with file/line/column diagnostics. This includes unmapped source. Ordinary
prose, identifiers and string/template/regex literals are not violations;
negative test fixtures belong outside `client/src`. This policy does not add
unrelated formatting or style rules.

Each entry produces its existing production `.js` path plus a linked `.js.map`
with relative source paths and embedded TypeScript source. Builds use deterministic
ordering and contain no timestamps or absolute checkout paths; tests compare bytes
across separate checkout paths. Commit both artifacts with source and manifests.
`client/generated-manifest.json` records manifest ownership, tool versions and
SHA-256 hashes of generated outputs. It is generated provenance, not a source entry
manifest. There is no fake entry when the manifest directory is initially empty.

All type checks and bundles complete in memory before any output is written.
Check mode compares byte-for-byte and never writes. Build mode only writes changed
artifacts; unmapped JavaScript is untouched. A moved/deleted entry with tracked
artifacts still on disk fails with an orphan list. Restore its mapping, or remove
its retired generated files explicitly after checking consumers, then rebuild.
The builder deliberately does not delete production resources automatically.

## The served bundle: minified twins, one featureContext, shared modules, size budget

`GET /JellyfinEnhanced/bundle.js` (`Features/Platform/Services/ClientScriptBundle.cs`)
concatenates the scripts listed in `js/component-scripts.json`. For each of them
the builder also writes a minified twin, `min/js/<path>` plus `min/js/<path>.map`:
the same source and wrapper with esbuild `minify`, an external map without
`sourcesContent` (the server copies each source's text from the readable map, so
`bundle.js.map` still carries the TypeScript). Only the bundle reads `min/`; the
readable `js/**` files stay what the per-file loader, dev tooling and tests use, and
both are in the ledger and checked by `--check`. `JE_TEST_MIN_TWINS=1` makes the
jsdom harness run the twins instead, to check that minifying changed no behaviour.

The bundle is sent pre-compressed (brotli, else gzip, by `Accept-Encoding`, with
`Vary: Accept-Encoding`) and a strong `ETag` per representation; a matching
`If-None-Match` gets a 304. Brotli starts at quality 9 and is replaced in the
background by quality 11.

Each module in the bundle is a parenthesized function, `(function () {…}),`: every
one of them runs exactly once at boot, and V8 compiles a parenthesized function
expression together with its script, on the thread that streams it in, instead of
lazily on the main thread at its first call (`BundleServingTests` checks the
wrapper). `bundle.js.map` is built when it is first requested, not with the script:
only a browser with developer tools open asks for it.

### Embedded assets are packed

The readable scripts, their source maps, the twins and the locales are 23.8 MB of
text. The plugin build packs them (`scripts/pack-embedded.mjs`, run by the
`PackEmbeddedClientAssets` target over the project's `JePackedAsset` items: brotli,
6.2 MB) and embeds each under its resource name plus `.jez`. Code reads every
embedded resource through `Infrastructure/Assets/PackedResources` by its plain
name, packed or not, and nothing else asks the assembly for one (a test refuses
it): a direct read of a packed resource finds nothing and looks like a missing
file. The admin section scripts and the data files that other features find by
enumerating resource names stay unpacked. `client/assembly-budget.json` is the
budget for what the DLL embeds (`PackedResourcesTests`), a ratchet like the
bundle's.

Feature hosts build their context with `featureContext` from `host/context.ts`,
which delegates to the one implementation `core/ui-kit.js` publishes on
`JE.core.featureContext` (non-enumerable) as its first statement, instead of each
feature output inlining it. Every feature script must stay after `core/ui-kit.js`
in `js/component-scripts.json` (`tests/client-build/feature-context.test.mjs`).
Scripts that run before the bundle (splash, login image) use
`createFeatureContext` directly. Tests that load a feature script on its own get
the same function from `tests/frontend/helpers/feature-context.cjs`.

### Shared modules (canopy K1b)

Each component script is its own esbuild bundle, so a module several scripts
import used to be inlined into each of them. `client/shared-modules.json` lists
such modules, each with its *provider*: the first script in
`js/component-scripts.json` that uses it. When the component scripts are built
(readable and twin alike), `scripts/client/shared-modules.mjs`:

- injects into the provider a module, evaluated before the provider's own code,
  that publishes the module's namespace on `JE.core.sharedModules`
  (non-enumerable; `publishSharedModules` in `host/context.ts`; an existing copy
  is kept);
- replaces the module, in every other component script that imports it, with a
  generated stub that reads that namespace when the script loads
  (`sharedModule`) and re-exports it. The generated modules are named
  `client/generated-shared/{publish,stub}/…` in outputs and maps; that folder
  never exists on disk.

Source files do not change. The build fails if a script that reads a shared
module is listed before its provider, if a listed module has no other user, or
if the module **or anything it imports** may hold state: a top-level
`let`/`var`, class, collection, call or statement (two inlined copies of a
stateful module are two separate states, which one shared copy would merge). A
binding the syntactic check cannot clear needs a `reviewed` entry with its
reason. `tests/client-build/shared-modules.test.mjs` also checks the committed
outputs (one carrier per module, every reader after it) and that no client
source mutates a shared module's constant tables.

Only add a module when sharing saves bytes: the provider publishes the whole
namespace, and each reader pays for a small stub. Modules left duplicated on
purpose, because they keep state, are listed in the manifest's notes. Tests that
load a reader without its provider get the same module from
`tests/frontend/helpers/feature-context.cjs` (`provideSharedRuntime`; the jsdom
harness does it in `load()`, Playwright specs through `provideFeatureContext`).

`client/bundle-budget.json` caps the served bundle's identity body, raw and gzip
-9 (`tests/backend/Api/BundleBudgetTests.cs` in the backend suite, and
`scripts/restructure-gates.sh size`). It is a ratchet: lower `limits` freely; a
new `history` entry that raises either limit must give a `reason`.

## Direct .NET builds

Root `Directory.Build.targets` scopes `VerifyJellyfinEnhancedClient` to the plugin
project only. It runs `node scripts/client-build.mjs --check` before
`PrepareForBuild`, `CoreCompile`, or `GenerateNuspec`, including incremental builds
and packaging. IDE design-time evaluation is excluded. The target checks rather
than regenerates so the resource glob sees committed, already-present artifacts.
Missing tools, strict type errors and stale JavaScript/maps/provenance stop the
build with an actionable command. There is no automatic npm install and no release
bypass property. No plugin `.csproj` changes are needed for this hook.

Generated standalone and dashboard pages use the [typed HTML build contract](html-build.md), including loader-safe inline scripts, source maps and freshness checks.

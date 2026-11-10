# Bootstrap transport boundary

The bootstrap slice is implemented; the product rewrite remains in progress. `Transport/BootstrapResponse.cs` and `Transport/BootstrapConfig.cs` define the actual server response, explicit public/private projections, nullable document envelope and prefetched envelope. Existing configuration/document model classes remain authoritative for their nested values. The controller constructs these DTOs, retaining token-user scoping, the administrator gate, no-store metadata, shared standalone-endpoint projections and null on document-load exceptions.

`BootstrapSettings` adds the request-derived `IsAdmin` field to the existing user-settings model. The bootstrap adapts the existing settings builder through an internal JSON conversion, retaining its existing seeding and normalization behavior; no transport response is treated as trustworthy merely because TypeScript has a matching interface. The settings file manager's existing lenient read behavior is unchanged: some missing/corrupt documents already yield model defaults, while exceptions caught by the bootstrap loader yield null.

## Generation and build integration

Run `scripts/generate-client-contracts.sh` to regenerate, or append `--check` to compare without writing. The wrapper defaults to `DOTNET_PROCESSOR_COUNT=2` and locks `../je-v12-validation.lock` relative to the repository. Set `JE_VALIDATION_LOCK` to override the lock path. Do not wrap this locking script in another lock on the same file.

The underlying CLI is:

```sh
dotnet run --project tools/ClientContracts/ClientContracts.csproj -c Release -- . [--check]
```

`npm run contracts:generate` and `npm run contracts:check` call that CLI directly. They deliberately do not acquire a lock: `verify:rewrite` already owns the shared lock while invoking `contracts:check`. For standalone use on a shared checkout, use the shell wrapper, or run the npm/CLI command under the validation lock with `DOTNET_PROCESSOR_COUNT=2`.

Outputs are `contracts/bootstrap.schema.json`, `client/src/contracts/generated.ts`, and `client/src/contracts/schema.ts`. Reflection reads the compiled response type and recursively follows existing models, property names, nullable annotations, dictionary element types and supported serialization-ignore attributes. It instantiates no plugin/configuration/controller and calls no providers. Unsupported types fail generation; `object`/JSON values require the explicit `OpaqueBootstrapJson` marker. Output ordering is deterministic. Check mode reports stale files and returns 1 without altering them.

The generator has no plugin project reference. Its tool-only compilation links the authoritative bootstrap DTOs, user configuration, tag layout/look/shape models and their helper dependencies. `Shortcut` and helper signatures require the existing `PluginConfiguration` source; that in turn needs the custom-tag, Arr and analytics model sources and the Jellyfin 12 `BasePluginConfiguration` package type. These are whole linked sources, not duplicated or stripped wire declarations. The explicit source list in `tools/ClientContracts/ClientContracts.csproj` makes new dependencies fail compilation until accounted for. Only `BootstrapResponse` and its reachable property types are reflected, so unrelated configuration fields do not become client contracts.

Tool outputs live under `artifacts/client-contracts/` and are named `ClientContracts`, never the loadable plugin assembly. The tool is not packable. Generation can therefore repair stale schema files and invalid generated TypeScript without compiling or packaging the plugin and without a frontend bypass property. Ordinary plugin build/pack freshness enforcement remains unchanged.

After generation, run `node scripts/client-build.mjs` then `node scripts/client-build.mjs --check`. `client/entries/contracts.json` maps the validator entry to `js/contracts/bootstrap.js`. The shared builder also owns its source map and manifest record.

The focused boundary regression uses isolated copies under `artifacts/rewrite-contract-build-boundary/`, preserving the shared working files:

```sh
DOTNET_PROCESSOR_COUNT=2 flock "${JE_VALIDATION_LOCK:-../je-v12-validation.lock}" \
  node --test tools/ClientContracts/boundary.test.mjs
```

It verifies unchanged contract bytes, source drift with JSON naming/nullability/ignore metadata, non-mutating checks, recovery from broken schema/TypeScript, repeated deterministic generation, client build/check recovery, actual plugin build/pack rejection of stale outputs, and portable wrapper lock paths. It does not replace the full verifier or host testing.

## Runtime application

`parseBootstrap(value: unknown, expectedUserId: string, isAdmin: boolean)` validates against the generated schema before returning `BootstrapResponse`. It requires valid matching GUID identities and a nonempty version, validates nested known values, rejects private configuration or a forged settings-admin flag for an independently known non-admin, and retains explicit nulls. Validation does not coerce, strip fields or supply defaults. Model projections are closed; string-keyed dictionaries validate their values. Opaque feature JSON remains JSON, without claimed field-level types.

The existing `js/plugin.js` loads the generated validator before applying bootstrap responses. It gets the expected user/admin record independently through the host's `getCurrentUser`, verifies its identity, and captures the host client, user, server, URL, token and observed identity epoch around the request. Shared promises and prefetched caches are scoped to that identity. A stale startup response restarts initialization for the new identity; a stale scoped reload does not write. Invalid responses retain the existing standalone-endpoint fallback. Document nulls reach the existing document fallback logic unchanged.

## Verification

Focused commands:

```sh
node --test tests/frontend/contracts/*.test.mjs tests/frontend/bootstrap/*.test.mjs
DOTNET_PROCESSOR_COUNT=2 flock /home/jake/projects/je-v12-validation.lock \
  dotnet test tests/backend/JE.Tests.csproj -c Release --no-restore \
  --filter 'FullyQualifiedName~BootstrapContractTests|FullyQualifiedName~ApiConfigurationTests|FullyQualifiedName~PerfRound2TagCacheResponseTests'
scripts/generate-client-contracts.sh --check
node scripts/client-build.mjs --check
```

The frontend set passed 352 tests. The backend set passed 55 tests, including actual C# serialized responses passed through the shipped JavaScript validator via `tests/frontend/contracts/check-wire.mjs`. Coverage includes identity mismatch/missing fields, nested malformed data, independent admin expectations, private-field smuggling into public config, nullable failure documents, fallback behavior, stale user/server responses, authorization metadata, token scoping, secrets exclusion and projection parity. A temporary-directory generation check also verified byte-identical repeated output and a non-mutating exit-1 stale check. These are focused checks, not a new full-suite or real-host validation claim.

## Remaining work

- `SeerrUserStatus`, `SeerrStatus`, and active-session cached answers are explicitly opaque `JsonValue` contracts, with their current server gates and shapes preserved. Their feature consumers still need typed endpoint contracts and validators. The existing model dictionaries (bookmarks, hidden items, spoiler state, layout locks) retain their typed nested values.
- Standalone fallback endpoints and other feature transports have not been migrated to generated validators in this slice.
- Most of `plugin.js` remains legacy JavaScript; only bootstrap loading/application integration changed. Durable settings revisions, settings policy extraction, full controller extraction, full feature parity and real Jellyfin-host proof remain separate work.
- No commit, push, deploy, publication or live installation changes were performed.

The typed bootstrap and revisioned settings endpoints use `TransportJson` to keep PascalCase names and explicit nulls while retaining Jellyfin converters. Jellyfin 12 normally omits null properties; inheriting that host default makes its actual HTTP responses fail the generated required-field contracts. Tests serialize with the endpoint’s selected options, and the disposable host/browser journey covers the real formatter.

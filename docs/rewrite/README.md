# Jellyfin Enhanced 12 rewrite

Status: implementation in progress. This branch is not a finished rewrite or a release.

## Accepted scope

A ground-up replacement of the JE implementation, preserving the current product feature set, targeting Jellyfin 12.x only. The server remains a C#/.NET plugin; browser code becomes strict TypeScript. Keep existing installation, settings and stored data usable through explicit migrations. Do not deploy to any live server or publish a release during development. Existing benchmark runs are separate work.

The baseline is upstream commit 2e0f9251bfe833cb58866e9e245ba62be69a69ad. On the Lenovo, the untouched baseline passed all 2,591 frontend tests and 2,727 backend tests on 2026-11-07. These tests are a regression reference, not proof of complete feature coverage.

## Architecture decisions

- C# owns authentication, authorization, persistence, protected data projection and upstream integrations. Browser visibility is never the access-control boundary.
- TypeScript owns browser features, with explicit host adapters, lifecycle disposal, account/server identity epochs and typed feature contracts. Use ES modules for source dependencies; isolate the legacy global bridge during replacement.
- Generate transport types from an authoritative server contract and validate untrusted input at runtime. Do not hand-maintain separate incompatible client/server interfaces.
- Preserve feature behavior while replacing modules behind their existing entry points. Existing JavaScript is transitional and does not count as completed TypeScript work. No empty substitutes, broad `any`, `@ts-nocheck`, or assertions merely to silence errors.
- Keep supported 12.x host and layout assumptions explicit. Removing 10.11 support does not implicitly remove layouts, native-client server behavior, translations or integrations.
- Keep all current data until a tested migration explicitly converts it. Scope caches and pending work by server and user. Stale responses must not update a new identity.
- Keep pure domain logic separately testable. Test the real routes and browser controls as well as helpers. Add adversarial state-transition, denied-access and mutation tests where useful.
- Type checking, build generation, backend compilation, existing regressions and targeted real-host checks gate integration. Generated production assets must be reproducible and verified against source.

## Frontend layout shared by parallel work

Use `client/src/` for TypeScript. Preserve source-relative feature paths where practical. Each independent feature group owns a JSON file under `client/entries/` mapping its production output paths (relative to `Jellyfin.Plugin.JellyfinEnhanced/`) to its TypeScript entry sources (relative to repo root). Example: `{ "js/core/session.js": "client/src/core/session-entry.ts" }`.

The build owner implements deterministic discovery of these manifests, collision checks, strict type checking (tsc-rs; see [frontend-build.md](frontend-build.md)), esbuild browser IIFE compilation, and a check mode that detects stale generated output. TypeScript imports may be bundled into each entry while existing server manifest paths remain stable during integration. Compiled outputs replace their old JS implementations; do not ship two competing owners. Keep maps/source manifests clear so debug and review refer to TS sources.

Each feature should define narrow interfaces at its adapter boundary, not a permissive global bag. Source modules should accept their dependencies explicitly. New pure logic should not access browser globals. Never weaken existing tests simply to pass a rewritten implementation.

## Review and verification

Use [REVIEW.md](../../REVIEW.md) for independent review of each stable feature slice. Keep findings and command output under ignored artifacts, tied to the reviewed revision. Repeated mistakes should become executable checks or simpler interfaces. The review protocol does not replace real-host validation.

## Completion requirements

All production JavaScript and embedded admin logic must be accounted for in a feature-parity inventory. The pinned baseline contains 182 ordered modules and 209 production JavaScript files (27 outside the ordered manifest), plus inline HTML runtime scripts. Run `node scripts/rewrite-inventory.mjs` to refresh [the structural inventory](migration-inventory.json), or add `--check` to detect drift. The optional `--require-complete` rejects remaining legacy/inline scripts; passing it alone is not behavioral parity. A completed rewrite requires typed replacements or a documented, intentional exclusion approved by the user; generated assets and third-party assets are not hand-written runtime modules. No claim of completion while functional modules remain unconverted. Establish the release validation set and record every unresolved gap honestly.

The [bug ledger](bug-ledger.json) tracks distinct confirmed findings, fix evidence and independent verification separately. Review artifacts retain full reproductions and hashes on the development host. Counts exclude repeated reports and test failures for the same defect; the ongoing audit also reconciles implementation and integration discoveries.

Generated standalone and dashboard pages use the [typed HTML build contract](html-build.md), including loader-safe inline scripts, source maps and freshness checks.

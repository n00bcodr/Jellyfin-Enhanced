# Frontend regression tests

Run `npm ci`, then `npm run test:frontend` (Node 22.12 or newer). Run
`npm run test:frontend:coverage` for instrumented production-module coverage.
These are isolated DOM/module tests, not tests against a live Jellyfin host.
`npm run test:browser` provides the separate browser suite.

Each test evaluates real classic-script production modules in a fresh jsdom
window. The shared helper refuses unexpected network access, closes windows and
timers, and fails on uncaught browser errors. Tests supply synthetic host APIs
and local responses. Register `t.after(() => harness.close())` in every test.
Use deferred promises for concurrency tests and actual MutationObserver delivery
for DOM behavior. Do not add arbitrary sleeps or retries.

Coverage instruments loaded modules and adds zero-coverage entries for **every**
production `.js` file under `Jellyfin.Plugin.JellyfinEnhanced/js`. There are no
production-module exclusions. jsdom/dependencies, test fixtures, and HTML inline
scripts are outside this JS coverage report. Reports are written to
`artifacts/frontend-coverage` (HTML, LCOV, JSON summary). Browser-suite execution
is not merged into this unit/DOM report.

Minimum floors are 28% statements, 30% lines, 20% branches, and 29%
functions across the whole production inventory (just under the measured
29.5% / 31.0% / 21.3% / 30.3%); these deliberately expose the
large remaining untested surface. The API, DOM observer, lifecycle, navigation,
and session modules individually require 60% statements and 45% branches.
These measured regression floors are not a completeness target. Raise them when
new coverage lands; never lower them merely to accept lost coverage. The
behavior coverage matrix records remaining gaps separately.

Mutation evidence: temporarily removing the API cache's session-epoch guard
caused `late previous-user response cannot repopulate cleared cache` to fail with
user A's response present after switching to B. The original source was restored.
The priority-subscriber replacement test also failed before the corresponding
DOM observer fix: a normal subscriber left at the start of the queue prevented
remaining high-priority subscribers from running before paint.

Unexpected console errors fail teardown; negative tests must explicitly allow
only their expected diagnostic with `h.expectConsoleError(/specific message/)`,
and teardown also fails if that expected error never happened. Use
`h.allowConsoleError(...)` only for a diagnostic that legitimately may or may
not occur. Unexpected default fetch calls fail teardown even when production
catches them.

`h.load()` wraps each file exactly as the production bundle does
(`Services/ClientScriptBundle.cs`), and `bootstrap/bootstrap-manifest.test.mjs`
loads every `js/component-scripts.json` entry in manifest order, so a module that
needs another file's top-level declarations, or a module later in the manifest,
while it loads fails here. Both runners
pin `TZ=UTC` and an `en_US.UTF-8` locale and give each test a 20 second timeout.

Specs are grouped by feature under `bootstrap/`, `core/`, `features/`, `pages/`,
`requests/`, and `regressions/`. Both runners discover nested `*.test.mjs` files
through `helpers/discovery.mjs`; an empty discovery fails. Shared helpers live
in `helpers/`. See the [test directory guide](../README.md) for contribution rules.

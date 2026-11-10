# Review round 6 (independent, read-only)

## (a) Round-5 fixes verified

- **Prerequisite base-prep:** the commands are correct. On the current tree, `generate.py --check` exits 1 ("Inventory is stale"). The api-routes-docs test passes 2/2, but only against the stale 200-route inventory. I generated the inventory in memory into the scratchpad and nothing in the tree was written. The result has 202 routes. The only added routes are `GET` and `POST /JellyfinEnhanced/user-settings/{userId}/bookmark-document`, and none are removed. `files` goes from 473 to 478 and `storage_references` from 87 to 88. I then ran the test against that regenerated inventory and it fails both cases: totals 200≠202, and two routes have no row. So the step the plan prescribes ("document them in api.md") is real, it is needed, and its result is visible. No other test or CI step reads the inventory counts. Fix confirmed.
- **backend.md S0** uses the step-1 count (202) at L632 and L771, and §A expects 202. ✔
- **`LC_ALL=C sort`/`comm`** is used in PLAN L78 and in backend.md L619–620 for both the baseline and the gate. ✔
- **F1 `rg` pattern, literal-data exclusions and TOOL anchor-update guidance** are present in frontend.md L282 and PLAN's TOOL row. ✔ One small gap is in finding 1.

## (b) Findings (all MINOR; each one is caught loudly by its own step's gate)

1. **MINOR: the F1 sweep misses `'..'` path segments.** The pattern only matches `'../`. It misses `join(here, '..', '..', '..')` in `features-admin-config-media-tags-isolation.test.mjs:15`, a file that moves to `media-tags/admin/`. It also misses `join(dirname(...), '..', '..', '..', …)` in `features-admin-config-schema.test.mjs:8`, which matters if that file's depth changes. The miss is not silent: an ENOENT makes `npm test` fail and the pass count drops. **Fix:** add the alternation `|join\([^)]*'\.\.'` to the `rg` and add one `'..'` segment.
2. **MINOR: the Prerequisite comment says only "document them".** After regeneration the test also fails on the two totals in `docs/advanced/api.md` (L7 "covers the 200…" and the "enumerate all 200…" line). **Fix:** amend the comment to "add the 2 bookmark-document rows and change both totals to 202". The test fails loudly if this is skipped.
3. **MINOR: the order of the INV baseline is ambiguous.** Step 1 says INV must pass on the untouched base *before* S0. The baselines block, though, records `inventory-routes.txt` "after generate.py is fixed (S0)", so the file the pre-S0 diff needs doesn't exist yet. **Fix:** record `inventory-routes.txt` right after base-prep, which is valid because the route set is current. S0 then diffs against that file instead of re-saving it. Mismatches show up as a loud diff.

## Judgement
The plan is **ready**. An implementation agent can run PLAN.md from the Prerequisite through the Definition of done without being blocked. I found no behaviour change that would go uncaught.

MATERIAL_FINDINGS: 0

# Suite-speed validation

Behavioral source base: r21 (`b1a9ee65`). Measurements use one approved slot on Alex's laptop, Node 26.7.0 and SDK 10.0.401, affinity `0-3,6-9`, niceness 10 and aggregate MemoryMax 20 GiB. Each mode has its own source snapshot, reports and temporary directories. This is one paired series on a shared laptop, not an isolated-machine throughput estimate.

| Change | Before seconds | After seconds | Behavioral cases |
|---|---:|---:|---:|
| Immutable frontend instrumentation reuse, existing file scheduling | 768.80 | 263.63 | 3,674 → 3,674 |

The cache-only comparison retains all 239 production JS files, identical instrumentation point schemas and identical denominators. Every global and core-module floor remains enforced. Covered-hit variation is disclosed:

| Metric | Before covered | After covered | Unchanged denominator |
|---|---:|---:|---:|
| Statements | 38,440 | 38,426 | 56,112 |
| Branches | 26,402 | 26,394 | 43,752 |
| Functions | 5,655 | 5,653 | 8,095 |
| Lines | 32,982 | 32,978 | 46,423 |

The uncached baseline retains a cancellation at the existing 11-second Q13 deadline; cache-only completes all frontend cases without changing that deadline or its assertions. The inherited backend StampFeed failure remains visible. These are diagnostic measurements and do not certify a green full suite.

Regressions exercise real instrumented production text, changed source/filename/options, independent jsdom realms and counters, cross-process disk reuse, and rejection of corrupt cache text. Cache entries contain strings only and include the dependency-lock identity. Source transforms still have to apply before lookup; the zero-hit source inventory remains unchanged.

Complete receipts and subsequent steps are recorded in the coordinator's `suite-speed-report.md` and the retained lane artifacts.

Bounded scheduling was compared against cached existing scheduling on the same r21 behavioral inputs:

| Total file workers / nested cases / shards | Seconds | Frontend cases | Result |
|---|---:|---:|---|
| Existing automatic 8 / 8 / 1 | 263.63 | 3,674 | Complete |
| Explicit 2 / 4 / 2 | 400.16 | 3,674 | One unchanged abort-timing assertion failed |
| Explicit 4 / 2 / 2 | 286.09 | 3,674 | Complete |
| Explicit 8 / 8 / 2 | 259.86 | 3,674 | Complete |

The explicit speed profile uses eight file workers by default; lower settings are opt-in. The ordinary command retains Node’s automatic worker count. Only two files have nested concurrent suites, so the maximum is eight file workers and 22 asynchronous cases on the lane's eight CPUs. This preserves their existing concurrency of eight. Frontend sharding defaults to one; the two-shard trial assigned 2,159 / 1,515 cases to four workers each. Unique run and shard directories retain raw counters, logs, and reports without deleting other output.

All trials retain identical point schemas (including repeated-location multiplicity) and denominators across 239 files. The eight-worker trial covers 38,437/56,112 statements, 26,400/43,752 branches, 5,655/8,095 functions and 32,981/46,423 lines, within all unchanged global/core floors. Its aggregate peak is 4.81 GiB. Small hit variation remains visible; the 1.4% difference from cached automatic scheduling is not a statistically established speedup. These are single samples on a shared laptop. The eight-worker continuation uses the original host/runtime but a later slot; host load/pressure is retained with the receipts.

Backend processes were measured with the complete r21 inventory and unchanged serial collections:

| Execution | Backend seconds | Full fast seconds | Cases / outcomes |
|---|---:|---:|---|
| Original single process | 3,161.89 | 3,935.19 | 27,876; one inherited StampFeed failure |
| Two processes, equal summed case-duration weights | 2,235.67 | 2,508.18 | Identical backend names and outcomes |
| Two processes, collection-aware critical path | 2,010.89 | 2,246.96 | Identical backend names and outcomes |

The historical final run used build reuse, which has since been removed after three correctness recurrences. The supported command now uses `--speed-profile --backend-shards 2 --backend-durations <saved-complete.trx>`; sharding remains opt-in and each backend invocation builds. Without a saved duration profile the assignment balances case counts. Keep the complete TRX outside a results directory that the next run replaces.

Equal case-duration sums did not balance wall time: the first partition trial took 2,180.91 / 1,223.57s per worker. The measured-profile model now accounts for disabled collections plus ordinary collection jobs on the actual `8 // shards` xUnit slots. It assigns Plugin singleton's 11,064 cases alone (2,003.29s worker time) and the remaining 16,812 cases together (758.17s). The long worker contains 1,972.97s of serialized case time: that unsplittable collection is the limiting floor, and the worker finishes within 1.6% of it. Equal finish times would require slowing the other process or splitting the protected collection. Both serial collections remain inside a single process; every method/class assignment is complete and disjoint.

Real Coverlet diagnostic unions retain exactly 73,249 line points and 67,830 branch points, matching the original XML reporter's denominators. Covered points are 61,001 → 61,002 lines and 51,741 → 51,742 branches, above unchanged 47% / 35% floors. Per-method line identity and complete IL branch identity are preserved, including generated documents. Percentages are never averaged. The actual strict validator rejects the failed partition (exit 2); these diagnostics are not a green coverage certificate. CLI regressions also exercise successful unions and missing, empty, duplicate, incomplete and failed partition rejection.

The final frontend step completes all 3,674 cases in 231.92s. All 239 point schemas/denominators remain unchanged; covered totals are S38,429/56,112 B26,394/43,752 F5,651/8,095 L32,975/46,423. Every global/core floor holds. Aggregate cgroup peak is 16.61 GiB, below 20 GiB. Both separate production Release builds complete with zero warnings/errors (jf12 16.144s, jf10 16.140s). Host load, pressure, CPU time and raw reports remain available with the receipts. Build/global caches and shared-laptop load vary, so do not attribute the entire aggregate difference to the partition model alone.

The final build key was measured separately on an immutable final-helper snapshot on the same laptop and runtime:

## Coverage equivalence and hit variance

A fixed 93-case request-backend/household selection was run twice with the same
ordinary single-process configuration. Both executions passed exactly the same
cases and retained every per-file point and the 73,249 / 67,830 line/branch
denominators. Covered lines differed (6,295 / 6,296), while covered branches were
4,098 in both. The covered sets differed at the same request-grouping and
request-completion points seen in the retained full runs. The initial 135-case
control pair was identical, but did not hit any of the four full-run differences;
it could not establish determinism for those paths.

The request code uses unseeded GUID identities and ordering among equal-time
work, so internal paths can vary without changing asserted outcomes. The
single-process pair demonstrates that sharding/union is not necessary for this
variance. An independent audit of the retained raw worker reports also locates
all four full-run differences before merging and verifies their exact summed
counters. This supports execution variance rather than an arithmetic union defect;
the background list-worker point was not reproduced by the focused pair.

`compare_evidence.compare_backend(...)["equivalent"]` requires nonempty equal
case/outcome inventories, exact per-file source/method/line/IL-branch inventories
and exact denominators. Covered hits and differing files remain diagnostics;
there is no requirement for identical hit sets or covered totals across process
layouts. This comparison does not certify a coverage gate: missing/failed shards,
invalid counters, incomplete execution, changed inventories and the existing
coverage floors still fail their respective strict validators. The union itself
continues to sum exact counters; no floor or exclusion changes.

## Default compatibility and opt-in execution

With no speed flags, `python3 tests/run.py fast --target jf12` keeps the
`b1a9ee65f` process contract: the historical prerequisite record and exit code,
continued diagnostics after inventory/tooling/pin failures, ordinary `dotnet test`
without `-m:4`, Node's automatic file concurrency and reporter, uncached
instrumentation, PID-only raw filenames, and no private frontend cache/run tree.
Lazy locale enumeration also requires the speed profile; ordinary helpers retain
the historical eager lookup. Clearing abandoned speed artifacts and an old totals sidecar when returning to default is a stale-evidence
bug fix; it does not change fresh default artifacts.

`--speed-profile` enables runtime/SDK/dependency/worker preflight, fail-fast
incomplete inventory/tooling/pin handling, bounded backend MSBuild work (`-m:4`),
and the immutable frontend text cache and bounded frontend workers. Backend shards greater than one, duration profiles and witness options also
select this profile. Direct Node callers opt
in with `JE_SPEED_PROFILE=1`; `JE_NODE_FILE_CONCURRENCY`,
`JE_NODE_NESTED_CONCURRENCY`, `JE_FRONTEND_SHARDS` and
`JE_FRONTEND_COVERAGE_ROOT` apply within that profile. `JE_INSTRUMENT_CACHE=0`
disables caching there; `JE_INSTRUMENT_CACHE=1` explicitly enables only the
low-level text cache for focused comparisons.

The ordinary backend keeps TRX/collector attachments directly under
`artifacts/regression/backend/<target>` and build output under
`artifacts/regression/build/<target>/{bin,obj}`. Shards, duration profiles and
witnesses select the isolated fresh snapshot/worker layout. A lock protects that
invocation's build and copies. A new execution run ID associates partition
receipts; it certifies no build inputs and cannot enable cross-invocation reuse.
`--preflight-witnesses` still executes exactly the known StampFeed fact and stops
nonzero/incomplete on failure, leaving the remaining gate unexecuted. A fully
accounted failed backend still permits frontend diagnostics.

Default frontend coverage writes fresh `artifacts/frontend-coverage/raw/*.json`
and the historical summary/HTML/LCOV tree directly. Only speed-profile runs use
private counters/receipts in `artifacts/.frontend-coverage-runs/run-*`, UUID raw
names, and immutable text in `artifacts/.frontend-instrumented`. Sharded runs read
only their own raw maps; interrupted runs cannot contaminate the next report or
delete another invocation's private counters.

## Build reuse removed (SS-E1, three recurrences)

`--reuse-build` is removed, not disabled. Both CLIs reject it as an unrecognized
argument; every backend invocation builds. `msbuild_inputs.py`, build-input and
output fingerprints, source-control/SDK/input closure identities, reuse stamps,
and their feature-specific fixtures/tests are removed. Shards, complete/disjoint
duration partitions, strict coverage union, frontend instrumentation caching and
preflight witnesses remain.

The first reuse identity missed external imports; the second missed referenced
projects' file inputs; the third canonicalized evaluated source paths and lost
build-significant logical filenames. Renaming an external symlinked Compile
input from `Value.cs` to `Renamed.cs` left canonical target bytes unchanged, so
reuse ran an old DLL whose CallerFilePath still said `Value.cs`. A fresh build
correctly said `Renamed.cs`. The pre-committed third-recurrence rule therefore
dropped the mechanism from this tier.

A future attempt needs a separate design and independent review: preserve every
evaluated logical path together with target/content identity throughout the
transitive project/input graph; cover membership transitions, imports, properties,
SDK/configuration and external inputs; fail closed when identity cannot be
proved. Require the actual symlink-rename/CallerFilePath output regression as
well as external props/source edits and unreadable/unknown-input cases. Hashing
canonical target bytes alone cannot prove correctness. Independent verification
and a separate soak must precede reintroduction.

Default artifacts keep the pre-tier schema; speedup outputs are additive files.
In particular, backend `coverage-summary.json` retains exactly the fields emitted
by the actual pre-tier validator at `b1a9ee65f` (frozen in
`tests/fixtures/suite-speed/backend-default-summary.json`). It has no `totals`
field. Only a validated multi-shard invocation writes the additional
`coverage-summary.totals.json`; an ordinary validation removes a retained sidecar.

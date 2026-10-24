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

Eight file workers remain the default; lower settings are opt-in. Only two files have nested concurrent suites, so the maximum is eight file workers and 22 asynchronous cases on the lane's eight CPUs. This preserves their existing concurrency of eight. Frontend sharding defaults to one; the two-shard trial assigned 2,159 / 1,515 cases to four workers each. Unique run and shard directories retain raw counters, logs, and reports without deleting other output.

All trials retain identical point schemas (including repeated-location multiplicity) and denominators across 239 files. The eight-worker trial covers 38,437/56,112 statements, 26,400/43,752 branches, 5,655/8,095 functions and 32,981/46,423 lines, within all unchanged global/core floors. Its aggregate peak is 4.81 GiB. Small hit variation remains visible; the 1.4% difference from cached automatic scheduling is not a statistically established speedup. These are single samples on a shared laptop. The eight-worker continuation uses the original host/runtime but a later slot; host load/pressure is retained with the receipts.

Backend processes were measured with the complete r21 inventory and unchanged serial collections:

| Execution | Backend seconds | Full fast seconds | Cases / outcomes |
|---|---:|---:|---|
| Original single process | 3,161.89 | 3,935.19 | 27,876; one inherited StampFeed failure |
| Two processes, equal summed case-duration weights | 2,235.67 | 2,508.18 | Identical backend names and outcomes |
| Two processes, collection-aware critical path | 2,010.89 | 2,246.96 | Identical backend names and outcomes |

The final run uses `--backend-shards 2 --backend-durations <saved-complete.trx> --reuse-build`; sharding remains opt-in. Without a profile the assignment balances case counts. Keep the complete TRX outside a results directory that the next run replaces.

Equal case-duration sums did not balance wall time: the first partition trial took 2,180.91 / 1,223.57s per worker. The measured-profile model now accounts for disabled collections plus ordinary collection jobs on the actual `8 // shards` xUnit slots. It assigns Plugin singleton's 11,064 cases alone (2,003.29s worker time) and the remaining 16,812 cases together (758.17s). The long worker contains 1,972.97s of serialized case time: that unsplittable collection is the limiting floor, and the worker finishes within 1.6% of it. Equal finish times would require slowing the other process or splitting the protected collection. Both serial collections remain inside a single process; every method/class assignment is complete and disjoint.

Real Coverlet diagnostic unions retain exactly 73,249 line points and 67,830 branch points, matching the original XML reporter's denominators. Covered points are 61,001 → 61,002 lines and 51,741 → 51,742 branches, above unchanged 47% / 35% floors. Per-method line identity and complete IL branch identity are preserved, including generated documents. Percentages are never averaged. The actual strict validator rejects the failed partition (exit 2); these diagnostics are not a green coverage certificate. CLI regressions also exercise successful unions and missing, empty, duplicate, incomplete and failed partition rejection.

The final frontend step completes all 3,674 cases in 231.92s. All 239 point schemas/denominators remain unchanged; covered totals are S38,429/56,112 B26,394/43,752 F5,651/8,095 L32,975/46,423. Every global/core floor holds. Aggregate cgroup peak is 16.61 GiB, below 20 GiB. Both separate production Release builds complete with zero warnings/errors (jf12 16.144s, jf10 16.140s). Host load, pressure, CPU time and raw reports remain available with the receipts. Build/global caches and shared-laptop load vary, so do not attribute the entire aggregate difference to the partition model alone.

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

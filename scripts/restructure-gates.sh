#!/usr/bin/env bash
# Gates for the v12 restructure (artifacts/restructure-plan/PLAN.md "Gates", backend.md §4 "Commands",
# frontend.md §3 gate G). Each gate runs in a `set -e` subshell; the script exits non-zero on the first failure.
#
#   scripts/restructure-gates.sh be              backend B, G, T, F + INV + TOOL, as four concurrent lanes (run_lanes)
#   scripts/restructure-gates.sh fe              frontend gate G (includes INV and TOOL)
#   scripts/restructure-gates.sh all             be's lanes plus fe's regeneration, each check once (merge points)
#   scripts/restructure-gates.sh browser         npm run test:browser, failures ratcheted vs baselines/browser-failures.txt
#   scripts/restructure-gates.sh r <pattern>     no stale references: fails if `git grep -nE <pattern>` matches outside artifacts/
#   scripts/restructure-gates.sh h               poster harness builds + gen-resolution-data --check
#   scripts/restructure-gates.sh inv             generate.py --check + route list == baselines/inventory-routes.txt (never regenerates)
#   scripts/restructure-gates.sh tool            python3 tests/run.py tooling + no AI attribution in commits since the base
#                                                + mutation/history path check vs baselines/mutation-check.txt
#   scripts/restructure-gates.sh bundle <out.js> raw bytes of the in-process GET /JellyfinEnhanced/bundle.js; prints nothing on stdout
#   scripts/restructure-gates.sh bundle-hash <f> prints `<stable sha256> <comment-stripped sha256>` of a bundle file
#   scripts/restructure-gates.sh size            served bundle raw and gzip -9 bytes vs client/bundle-budget.json (ratchet)
#   scripts/restructure-gates.sh image           the HOST image tag in baselines/jf12-digest.txt still has the recorded RepoDigest
#   scripts/restructure-gates.sh quick [feature…] THE inner loop, not a merge gate: typecheck, client build, inventory,
#                                                the features' node tests + architecture + guards (new failures only),
#                                                their dotnet tests + Architecture when a .cs file changed, and, when an
#                                                affected map is recorded, also the node test files and (chromium) specs
#                                                whose traced inputs the change touches. Features default to those the
#                                                diff from $JE_BASE_REF (else restructure/integration) touches.
#   scripts/restructure-gates.sh affected record records the affected map for HEAD (tests/runner/affected.py; needs
#                                                strace, ~5 min); `affected` alone is an alias of `quick`
#
# Pre-existing test failures are ratcheted, not fixed: a dotnet or node test run passes when every failing test is
# listed in baselines/{dotnet,npm}-failures.txt and the total and passed counts are >= baselines/{dotnet,npm}-tests.txt.
# The browser suite passes when every failing test is listed in baselines/browser-failures.txt.
#
# Run dotnet gates one worktree at a time on the 16 GB worker (PLAN.md "Worktrees and parallelism"). Inside be and all
# the lanes run at once: dotnet (B, one test build, G, T as several test hosts), frontend, contracts (its own tool build
# and a fixture copy) and checks; at most the dotnet lane's build or test hosts and the contracts lane's tool run overlap
# (peak about 6 GB). Tuning: JE_TEST_CONCURRENCY (node test files at once; default max(4, cores - 1)),
# JE_DOTNET_SINGLETON_SHARDS (T's singleton test hosts; default 3, 0 = one process), JE_GATE_WIDE_NICE (priority of the
# frontend and checks lanes; default 5), JE_GATE_FAIL_FAST=1 (stop the other lanes at the first failure),
# JE_BROWSER_WORKERS (Playwright workers; default the cores up to 10, less those busy now, at least 6),
# JE_BROWSER_LONG / JE_BROWSER_LONG_WORKERS (spec files run as a second Playwright run; default
# tag-row-subpixel.spec.cjs with 1 worker, 2 from 12).
# scripts/gate-timing.py times any gate: wall, CPU and parallelism per step, test file and class.
set -euo pipefail

SELF=$(readlink -f "${BASH_SOURCE[0]}")
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
BASELINES=artifacts/restructure-plan/baselines
PLUGIN=Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj
TESTS=tests/backend/JE.Tests.csproj

step() {
  printf '\n== %s\n' "$*" >&2
  # scripts/gate-timing.py: one `<epoch seconds> <subshell pid> <label>` line per step, so the harness can attribute
  # each process to the step whose subshell started it. Unset (the default), nothing is written.
  if [ -n "${JE_GATE_TRACE:-}" ]; then printf '%s\t%s\t%s\n' "$(date +%s.%N)" "$BASHPID" "$*" >> "$JE_GATE_TRACE"; fi
}

# scripts/gate-timing.py: keep a copy of a test report (TRX, node results, Playwright JSON) as $JE_GATE_KEEP/<name>.
# A free TCP port on 127.0.0.1 (the fixture server binds it next).
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
keep_report() { if [ -n "${JE_GATE_KEEP:-}" ] && [ -s "$1" ]; then mkdir -p "$JE_GATE_KEEP"; cp "$1" "$JE_GATE_KEEP/$2"; fi; }

no_snapshot_updates() {
  if [ -n "${JE_UPDATE_SNAPSHOTS:-}" ]; then
    echo "JE_UPDATE_SNAPSHOTS is set; gates never update snapshots (PLAN.md gate BE). Unset it." >&2
    return 1
  fi
}

# backend.md §4: the mutation/history path check (stdlib only, no dotnet).
mutation_check() { python3 - <<'PY'
import glob, importlib.util, json, re, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('mutations', 'tests/runner/mutations.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)   # main() is guarded by __name__
defaults = set(re.findall(r"case\.get\('test_file', '([^']+)'\)", Path('tests/runner/mutations.py').read_text()))
cases = [('mutations.py', c) for c in m.CASES]
for f in sorted(glob.glob('tests/history/*-mutations.json')):
    cases += [(f, c) for c in json.load(open(f))]
bad = [f'default test_file missing: {d}' for d in defaults if not Path(d).is_file()]
for src, c in cases:
    if not Path(c['file']).is_file(): bad.append(f"{src}:{c['name']}: file missing {c['file']}"); continue
    if c.get('test_file') and not Path(c['test_file']).is_file(): bad.append(f"{src}:{c['name']}: test_file missing {c['test_file']}")
    n = Path(c['file']).read_text().count(c['before'])
    if n != 1: bad.append(f"{src}:{c['name']}: anchor occurs {n}x in {c['file']}")
print('\n'.join(sorted(bad)))
PY
}

# Failure ratchet. $1 label, $2 baseline failure list, $3/$4 baseline total/passed, $5 results file
# (`PASS|FAIL|SKIP <id>` lines), $6/$7 observed total/passed. New failures fail; listed tests that pass are a note.
ratchet() {
  local label=$1 list=$2 btotal=$3 bpassed=$4 results=$5 total=$6 passed=$7 rc=0 new gone
  new=$(sed -n 's/^FAIL //p' "$results" | LC_ALL=C sort -u | LC_ALL=C comm -23 - "$list")
  gone=$(sed -n 's/^FAIL //p' "$results" | LC_ALL=C sort -u | LC_ALL=C comm -13 - "$list")
  if [ -n "$new" ]; then
    echo "$label: $(printf '%s\n' "$new" | wc -l) failing test(s) not in $list:" >&2
    printf '  %s\n' "$new" >&2
    rc=1
  fi
  if [ -n "$gone" ]; then
    echo "$label: note: listed in $list but did not fail (now passing, or no longer run; remove it from the list):" >&2
    printf '  %s\n' "$gone" >&2
  fi
  if [ -z "$total" ] || [ -z "$passed" ]; then echo "$label: could not read the test counts" >&2; return 1; fi
  if [ "$total" -lt "$btotal" ]; then echo "$label: total $total < baseline $btotal" >&2; rc=1; fi
  if [ "$passed" -lt "$bpassed" ]; then echo "$label: passed $passed < baseline $bpassed" >&2; rc=1; fi
  echo "$label: total $total (baseline $btotal), passed $passed (baseline $bpassed), failed $(grep -c '^FAIL ' "$results" || true) (baseline list $(wc -l < "$list"))" >&2
  return "$rc"
}

# npm test == npm run test:frontend == node tests/frontend/run.mjs (package.json), so one ratcheted runner serves
# both FE G (`npm test`) and BE F (`npm run test:frontend`). Counts come from the spec reporter's `ℹ tests|pass N` lines.
frontend_tests() {
  local dir rc=0 first='' early=''
  dir=$(mktemp -d)
  # Run the files the affected map says this change can reach (none when there is no map or the change is global) as a
  # first part, then the rest: a broken change then fails in the first seconds. Every file runs once; the two parts'
  # results and counts are added up. (`node --test` sorts the files it is given, so one command cannot set the order.)
  if [ -s node_modules/.cache/je-affected/map.json ]; then
    python3 tests/runner/affected.py select --json 2>/dev/null \
      | python3 -c 'import json, sys; s = json.load(sys.stdin); print("\n".join([] if s["all"] else s["suites"].get("frontend", [])))' \
      > "$dir/first" 2>/dev/null || true
    if [ -s "$dir/first" ]; then echo "frontend tests: the $(wc -l < "$dir/first") file(s) the change can reach run first" >&2; first="$dir/first"; fi
  fi
  # In the lanes, every failing test is also written to a lane log the moment it fails, for the failure watcher.
  if [ -n "${JE_LANE_LOG_DIR:-}" ]; then early="$JE_LANE_LOG_DIR/frontend-early.log"; fi
  local part parts=all
  [ -z "$first" ] || parts='first rest'
  for part in $parts; do
    JE_TESTS_FIRST=$first JE_TESTS_PART=${first:+$part} JE_EARLY_FAILURES=$early node tests/frontend/run.mjs \
      --test-reporter=spec --test-reporter-destination=stdout \
      --test-reporter="$ROOT/scripts/restructure-gates-reporter.mjs" --test-reporter-destination="$dir/results-$part" \
      | tee "$dir/out-$part" || rc=$?
  done
  cat "$dir"/results-* > "$dir/results" 2>/dev/null || true
  cat "$dir"/out-* > "$dir/out"
  [ -s "$dir/results" ] || { echo "frontend tests: no results written (node exit $rc)" >&2; rm -rf "$dir"; return 1; }
  keep_report "$dir/results" frontend-results.txt
  rc=0
  ratchet "npm test" "$BASELINES/npm-failures.txt" \
    "$(awk '$1=="ℹ" && $2=="tests" {print $3}' "$BASELINES/npm-tests.txt")" \
    "$(awk '$1=="ℹ" && $2=="pass" {print $3}' "$BASELINES/npm-tests.txt")" \
    "$dir/results" "$(awk '$1=="ℹ" && $2=="tests" {n++; s+=$3} END {if (n) print s}' "$dir/out")" \
    "$(awk '$1=="ℹ" && $2=="pass" {n++; s+=$3} END {if (n) print s}' "$dir/out")" || rc=$?
  rm -rf "$dir"
  return "$rc"
}

# TRX -> first line `<total> <passed>`, then `PASS|FAIL|SKIP <testName>` per result.
trx_results() { python3 - "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
ns = '{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}'
root = ET.parse(sys.argv[1]).getroot()
c = root.find(f'{ns}ResultSummary/{ns}Counters')
print(c.get('total'), c.get('passed'))
for r in root.iter(f'{ns}UnitTestResult'):
    o = r.get('outcome')
    print('PASS' if o == 'Passed' else 'SKIP' if o == 'NotExecuted' else 'FAIL', r.get('testName'))
PY
}

# Build log -> sorted, de-duplicated `<code> <file relative to repo>` (no line numbers).
build_warnings() { python3 -c '
import os, re, sys
root = os.path.realpath(sys.argv[1]) + os.sep
out = set()
for line in sys.stdin:
    m = re.match(r"\s*(.+?)(?:\(\d+(?:,\d+)*\))?\s*:\s+warning\s+([A-Za-z]+\d+)\s*:", line)
    if m:
        f = m.group(1).strip()
        out.add(f"{m.group(2)} {f[len(root):] if f.startswith(root) else f}")
print("\n".join(sorted(out)))
' "$ROOT" | sed '/^$/d' | LC_ALL=C sort -u
}

inventory_routes() {
  python3 -c "import json;[print(r['verb'],r['path']) for r in sorted(json.load(open('tests/docs/production-inventory.json'))['routes'],key=lambda r:(r['path'],r['verb']))]"
}

# The commits a change owns start after this: JE_BASE_REF, else restructure/integration, else main (the trial
# checkouts have only main); HEAD itself when none exists.
change_base() {
  local ref
  for ref in ${JE_BASE_REF:-} restructure/integration main; do
    if git rev-parse -q --verify "$ref^{commit}" >/dev/null; then git merge-base HEAD "$ref"; return; fi
  done
  git rev-parse HEAD
}

# No AI attribution in commit messages (AGENTS.md): Co-Authored-By trailers or "Generated with/by" lines naming a tool.
attribution_check() (
  set -e
  local base c hits=0 pat
  base=$(change_base)
  pat='^[[:space:]]*co-authored-by:.*(claude|anthropic|codex|openai|chatgpt|copilot|gemini|cursor|devin|aider)|generated (with|by|using) .{0,40}(claude|codex|chatgpt|gpt-|copilot|gemini|cursor|openai|anthropic|\bai\b)'
  for c in $(git rev-list "$base..HEAD"); do
    while IFS= read -r line; do
      echo "  $(git rev-parse --short "$c"): $line" >&2
      hits=$((hits + 1))
    done < <(git log -1 --format=%B "$c" | grep -iE "$pat" || true)
  done
  if [ "$hits" -gt 0 ]; then echo "TOOL: $hits AI-attribution line(s) in $(git rev-parse --short "$base")..HEAD (above); reword those commits" >&2; false; fi
)

gate_inv() (
  set -e
  step "INV: generate.py --check"
  python3 tests/inventory/generate.py --check
  step "INV: route list vs $BASELINES/inventory-routes.txt"
  inventory_routes | diff - "$BASELINES/inventory-routes.txt"
)

gate_tool() (
  set -e
  step "TOOL: python3 tests/run.py tooling"
  python3 tests/run.py tooling
  step "TOOL: no AI attribution in commit messages since the base"
  attribution_check
  # The inner loop's fast pre-check (tsc-rs) must keep agreeing with TypeScript 6, the gates' authority: the clean tree
  # plus 4 mutation sites drawn by the commit (each commit tries others), verdict and file:line compared (~15 s).
  if node scripts/typecheck-fast.mjs --available; then
    step "TOOL: tsc-rs agrees with TypeScript 6 (clean tree + 4 seeded mutations; scripts/typecheck-agreement.mjs --gate)"
    node scripts/typecheck-agreement.mjs --gate --sample 4 --seed "$(git rev-parse HEAD)" --jobs 2 \
      --checker "tsc6=node $ROOT/node_modules/typescript/bin/tsc" --checker "tsc-rs=$ROOT/node_modules/.bin/tsc-rs" > /dev/null
  else
    step "TOOL: tsc-rs agreement skipped: tsc-rs is not installed here (an optional dependency)"
  fi
  step "TOOL: mutation/history path check vs $BASELINES/mutation-check.txt"
  local out new
  out=$(mutation_check)
  new=$(printf '%s\n' "$out" | sed '/^$/d' | LC_ALL=C sort | LC_ALL=C comm -13 "$BASELINES/mutation-check.txt" -)
  if [ -n "$new" ]; then echo "New mutation/history path failures:" >&2; echo "$new"; false; fi
)

# B and G: plugin build (warning ratchet), then the Architecture gates.
be_build_and_g() (
  set -e
  no_snapshot_updates
  step "B: build plugin (--no-incremental, so every warning is reported) + warnings vs $BASELINES/build-warnings.txt"
  local log new
  log=$(mktemp)
  dotnet build "$PLUGIN" -c Release -p:JellyfinTarget=jf12 --no-restore --no-incremental -tl:off | tee "$log"
  new=$(build_warnings <"$log" | LC_ALL=C comm -23 - "$BASELINES/build-warnings.txt")
  rm -f "$log"
  if [ -n "$new" ]; then echo "B: build warnings not in $BASELINES/build-warnings.txt (code file):" >&2; printf '  %s\n' "$new" >&2; false; fi
  # One build serves G and T: the plugin was just built (B, same configuration), so the test project builds against
  # its output without building it again (BuildProjectReferences=false), and both test runs use --no-build.
  step "B: build the test project once against B's plugin build (G and T run --no-build)"
  dotnet build "$TESTS" -c Release --no-restore -p:JellyfinTarget=jf12 -p:BuildProjectReferences=false -tl:off
  if [ -d tests/backend/Architecture ]; then
    step "G: Architecture gates"
    dotnet test "$TESTS" -c Release --no-restore --no-build -p:JellyfinTarget=jf12 --filter "FullyQualifiedName~Architecture"
  else
    step "G: skipped (tests/backend/Architecture does not exist yet; added by backend S0)"
  fi
)

# T, plus the verify:rewrite backend part (coverage floors on T's results).
# T runs as several test-host processes at once (tests/runner/dotnet_shards.py): JE_DOTNET_SINGLETON_SHARDS (default 3)
# processes split the `Plugin singleton` classes, each running them alone and one at a time as xUnit does in one process,
# and one process runs every other test with xUnit's parallel collections. Results and coverage are merged (exactly:
# coverlet JSON, hits summed per line and branch). JE_DOTNET_SINGLETON_SHARDS=0 runs the whole suite in one process.
be_t() (
  set -e
  local res rc=0 plan name filter shards=${JE_DOTNET_SINGLETON_SHARDS:-3}
  local -a names=() pids=()
  res=$(mktemp -d)
  if [ "$shards" = 0 ]; then
    plan='{"all":""}'
  else
    plan=$(python3 tests/runner/dotnet_shards.py plan --shards "$shards")
  fi
  mapfile -t names < <(jq -r 'keys[]' <<<"$plan")
  step "T: full backend suite in ${#names[@]} test host(s): ${names[*]} (failure ratchet vs $BASELINES/dotnet-failures.txt, dotnet-tests.txt)"
  # Coverlet instruments the plugin (and test) assembly in place in the output directory and restores it after the
  # run, so concurrent test hosts must not share that directory: each host runs from its own copy (hard links, except
  # the assemblies coverlet rewrites, which are real copies), inside bin/ so the tests' upward search for the
  # repository root still works. `dotnet test` still runs the project (-p:OutDir points it at the copy), so the
  # collector and settings the project's package targets supply are the same as in one process.
  local out=tests/backend/bin/Release/net10.0 shards_dir=tests/backend/bin/Release/shards f
  rm -rf "$shards_dir"
  for name in "${names[@]}"; do
    filter=$(jq -r --arg n "$name" '.[$n]' <<<"$plan")
    mkdir -p "$shards_dir"
    cp -al "$out" "$shards_dir/$name"
    for f in "$out"/*.pdb; do
      cp --remove-destination "$f" "$shards_dir/$name/"
      cp --remove-destination "${f%.pdb}.dll" "$shards_dir/$name/"
    done
    # shellcheck disable=SC2086
    dotnet test "$TESTS" -c Release --no-restore --no-build -p:JellyfinTarget=jf12 -p:OutDir="$ROOT/$shards_dir/$name/" ${filter:+--filter "$filter"} \
      --logger "trx;LogFileName=$name.trx" --results-directory "$res/$name" --collect:"XPlat Code Coverage" \
      -- DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=json,cobertura >"$res/$name.log" 2>&1 &
    pids+=($!)
    if [ -n "${JE_LANE_LOG_DIR:-}" ]; then ln -sf "$res/$name.log" "$JE_LANE_LOG_DIR/dotnet-T-$name.log"; fi
  done
  for name in "${!pids[@]}"; do wait "${pids[$name]}" || rc=$?; done
  for name in "${names[@]}"; do
    echo "-- T host $name:" >&2
    grep -E '^(Passed|Failed)!|^\s+Failed |error' "$res/$name.log" >&2 || tail -n 20 "$res/$name.log" >&2
    [ -s "$res/$name/$name.trx" ] || { echo "T: $name wrote no TRX (dotnet test exit $rc); its log:" >&2; tail -n 80 "$res/$name.log" >&2; false; }
    keep_report "$res/$name/$name.trx" "T-$name.trx"
  done
  rm -rf "$shards_dir"
  python3 tests/runner/dotnet_shards.py merge "$res" "${names[@]}" > "$res/results"
  ratchet "T (dotnet test)" "$BASELINES/dotnet-failures.txt" \
    "$(grep -oE 'Total: *[0-9]+' "$BASELINES/dotnet-tests.txt" | grep -oE '[0-9]+')" \
    "$(grep -oE 'Passed: *[0-9]+' "$BASELINES/dotnet-tests.txt" | grep -oE '[0-9]+')" \
    "$res/results" $(head -1 "$res/results")
  # `npm run verify:rewrite` (scripts/client-verify.mjs) = contracts:check, client:check, inventory:rewrite:check,
  # test:client-build, test:contract-boundary, test:frontend, then `tests/run.py backend` (dotnet test + coverage floors).
  # It stops at the first pre-existing failure, so F runs those parts here instead: test:frontend ratcheted, the dotnet
  # run reused from T, and its coverage floors checked on T's results (merged over T's hosts).
  step "F: verify:rewrite backend part: coverage floors on T's results (tests/runner/coverage.py)"
  python3 tests/runner/coverage.py "$res/merged"
  keep_report "$res/merged/coverage-summary.json" coverage-summary.json
  rm -rf "$res"
)

# T and the ratcheted frontend suite at the same time, each in its own subshell with its own log. The frontend suite
# runs no dotnet, so dotnet still builds and tests one process at a time. Both tails are printed; either failing fails.
# Lanes. be and all run four lanes at once, each in its own subshell with its own log:
#   dotnet     B (plugin build, warning ratchet) -> test-project build -> G -> T (+ coverage floors on T's results)
#   frontend   the ratcheted frontend suite (node only; needs no dotnet build)
#   contracts  contracts:check -> test:contract-boundary (own tool project and fixture copy, no shared build output)
#   checks     test:client-build -> client:check -> inventory:rewrite:check -> INV -> TOOL [-> all: fe's part]
# Each lane stops at its own first failure (set -e). A lane's result is printed the moment it ends, so the first
# failure shows when it happens; then every lane's summary and tail (whole tail on failure). Any failed lane fails the
# gate. JE_GATE_FAIL_FAST=1 also stops the other lanes at the first failure (default: they run to the end).
lane_dotnet() ( set -e; be_build_and_g; be_t )
lane_frontend() ( set -e; step "F: frontend suite (ratcheted)"; frontend_tests )
lane_contracts() (
  set -e
  step "F: contracts"
  npm run contracts:check
  npm run test:contract-boundary
)
lane_checks() (
  set -e
  step "F: client-build tests + path readers"
  npm run test:client-build
  npm run client:check
  npm run inventory:rewrite:check
  gate_inv
  gate_tool
  if [ "${1:-}" = with-fe ]; then fe_checks in-all; fi
)

# run_lanes <name>=<command> ...: runs each command (a function, with its arguments) as a lane.
run_lanes() (
  set +e
  local dir t0 spec name pid rc failed=0 done_pid
  local -A lane_pid lane_rc lane_end
  dir=$(mktemp -d)
  t0=$(date +%s)
  # Lanes that start their own processes' logs (T's test hosts) put them here, so the watcher below sees them too.
  export JE_LANE_LOG_DIR=$dir
  step "lanes, concurrently: ${*%%=*} (separate logs; each result as it ends, then the tails)"
  for spec in "$@"; do
    name=${spec%%=*}
    # Lanes that are one long chain (dotnet, contracts) bound the run; lanes that are many parallel files (frontend,
    # checks) have slack. Under contention the chains should get the CPU first, so the wide lanes run at a lower
    # priority (JE_GATE_WIDE_NICE, default 5; 0 = all equal). Only the order in which the CPU is shared changes.
    # shellcheck disable=SC2086  # the command and its arguments are single words
    ( case $name in frontend|checks) renice -n "${JE_GATE_WIDE_NICE:-5}" -p "$BASHPID" >/dev/null ;; esac; ${spec#*=} ) >"$dir/$name.log" 2>&1 &
    lane_pid[$name]=$!
  done
  # The first failing line of any lane, as soon as it is written (a failing test, a type or build error), so a broken
  # change is reported long before its lane, let alone the gate, ends. Reporting only: every lane still runs.
  (
    seen=''
    while :; do
      for f in "$dir"/*.log; do
        case " $seen " in *" $f "*) continue ;; esac
        line=$(grep -m1 -E '^[[:space:]]*(✖|✘) |^[[:space:]]+Failed [A-Za-z]|error (TS|CS|MSB|NETSDK)[0-9]+|^Client build failed|failing test\(s\) not in|^not ok ' "$f" 2>/dev/null) || continue
        echo "FAILURE seen after $(( $(date +%s) - t0 )) s in lane $(basename "$f" .log) (the lane keeps running): ${line:0:300}" >&2
        seen="$seen $f"
      done
      sleep 1
    done
  ) &
  local watcher=$!
  local remaining=$#
  while [ "$remaining" -gt 0 ]; do
    wait -n -p done_pid
    rc=$?
    for name in "${!lane_pid[@]}"; do
      if [ "${lane_pid[$name]}" = "$done_pid" ]; then
        remaining=$((remaining - 1))
        lane_rc[$name]=$rc
        lane_end[$name]=$(( $(date +%s) - t0 ))
        if [ "$rc" = 0 ]; then
          echo "lane $name: passed after ${lane_end[$name]} s" >&2
        else
          failed=1
          echo "lane $name: FAILED (exit $rc) after ${lane_end[$name]} s; its last lines:" >&2
          tail -n 25 "$dir/$name.log" | sed 's/^/  | /' >&2
          if [ "${JE_GATE_FAIL_FAST:-}" = 1 ]; then
            echo "JE_GATE_FAIL_FAST=1: stopping the other lanes" >&2
            for pid in "${lane_pid[@]}"; do pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; done
          fi
        fi
      fi
    done
  done
  kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
  for spec in "$@"; do
    name=${spec%%=*}
    step "lane $name: summary and tail (exit ${lane_rc[$name]}, ${lane_end[$name]} s)"
    grep -E '^(Passed|Failed)!|^T \(dotnet test\)|^npm test:|^ℹ (tests|pass|fail|duration_ms) |"passed"|^B: build warnings|^lane |^restructure-gates' "$dir/$name.log" >&2 || true
    if [ "${lane_rc[$name]}" = 0 ]; then tail -n 4 "$dir/$name.log" >&2; else tail -n 250 "$dir/$name.log" >&2; fi
  done
  rm -rf "$dir"
  [ "$failed" = 0 ]
)

gate_be() (
  set -e
  run_lanes dotnet=lane_dotnet frontend=lane_frontend contracts=lane_contracts checks=lane_checks
)

gate_fe() ( set -e; fe_checks with-frontend-suite )

# $1 = with-frontend-suite (`fe`) | in-all (`all`, after be). In `all`, be has already run on this same tree (gate_all
# fails if fe's regeneration changes it) the frontend suite, test:client-build, client:check, inventory:rewrite:check,
# INV and TOOL, so fe runs only what be does not: the regeneration itself (client:build, which type-checks exactly as
# client:typecheck does before building, and inventory:rewrite), the bootstrap manifest test and the output keys.
fe_checks() (
  set -e
  if [ "$1" = in-all ]; then
    step "FE G: build (includes the typecheck), inventory; be ran the checks, INV, TOOL and client-build tests on this tree"
    npm run client:build
    npm run inventory:rewrite
    step "FE G: bootstrap manifest"
    node --test tests/frontend/bootstrap/bootstrap-manifest.test.mjs
  else
    step "FE G: typecheck, build, inventory"
    npm run client:typecheck
    npm run client:build
    npm run inventory:rewrite
    npm run client:check
    npm run inventory:rewrite:check
    gate_inv
    gate_tool
    step "FE G: client-build tests, bootstrap manifest, npm test (ratcheted)"
    npm run test:client-build
    node --test tests/frontend/bootstrap/bootstrap-manifest.test.mjs
    frontend_tests
  fi
  step "FE G: component-scripts.json and client/entries output keys vs restructure-base"
  git diff --exit-code restructure-base -- Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json
  local f
  for f in client/entries/*.json; do
    diff <(git show "restructure-base:$f" | jq -S keys) <(jq -S keys "$f")
  done
)

# Merge points: be's lanes, with fe's part (which regenerates: client:build, inventory:rewrite) at the end of the checks
# lane, so nothing is repeated. Everything be ran covers fe's tree only if the regeneration leaves the working tree as it
# was: the tree is compared at the start and at the end of the whole run.
gate_all() (
  set -e
  local before after
  no_snapshot_updates
  before=$(tree_state)
  run_lanes dotnet=lane_dotnet frontend=lane_frontend contracts=lane_contracts "checks=lane_checks with-fe"
  after=$(tree_state)
  if [ "$before" != "$after" ]; then
    echo "all: the working tree changed during the run (fe's regeneration, or a step that writes outside ignored paths), so the results do not cover one tree:" >&2
    git status --short >&2
    false
  fi
)

tree_state() { { git status --porcelain=v1 -uall; git diff HEAD; } | sha256sum; }

# Playwright JSON report -> `PASS|FAIL|SKIP <identity>` per test, identity = `[project] › <repo-relative file>:<line>:<col>
# › <describe titles › test title>`, as the list reporter prints it. unexpected and flaky (retries are 0) are FAIL.
browser_results() { python3 - "$1" "$ROOT" <<'PY'
import json, os, sys
data = json.load(open(sys.argv[1]))
root_dir = data['config']['rootDir']
def walk(suite, titles):
    for spec in suite.get('specs', []):
        path = os.path.relpath(os.path.join(root_dir, spec['file']), sys.argv[2])
        for test in spec['tests']:
            status = test['status']
            outcome = 'FAIL' if status in ('unexpected', 'flaky') else 'SKIP' if status == 'skipped' else 'PASS'
            print(outcome, f"[{test['projectName']}] › {path}:{spec['line']}:{spec['column']} › {' › '.join(titles + [spec['title']])}")
    for child in suite.get('suites', []):
        walk(child, titles + [child['title']])
for file_suite in data['suites']:   # the top level is one suite per file; its title is the file, not a describe
    walk(file_suite, [])
PY
}

# BROWSER (PLAN.md): npm run test:browser with a failure ratchet. New failures fail by name; a listed test that passes
# is a note (remove it from the list). Never add a line to baselines/browser-failures.txt.
# Workers: JE_BROWSER_WORKERS, default below. Playwright queues tests project by
# project and file by file, so a test that alone takes half a minute and sits late in the queue ends the run on its
# own. The spec files in JE_BROWSER_LONG (default tag-row-subpixel.spec.cjs; empty = one run) therefore run as a second
# Playwright run at the same time, with JE_BROWSER_LONG_WORKERS (default 1, 2 from 12 workers) of the workers and its own port; the
# results of both runs are ratcheted together. Every spec runs exactly once either way.
gate_browser() (
  set -e
  local dir rc=0 rc2=0 new gone cores long=${JE_BROWSER_LONG-tag-row-subpixel.spec.cjs} pid
  cores=$(nproc)
  # Workers: the cores, at most 10, less the cores other processes keep busy right now (sampled over 1 s, not the
  # lagging load average), at least 6. The long tests wait on frames, so on 10 real cores 10 workers beat 6 by a
  # third; but on the 16-thread second worker (4 performance + 8 efficiency cores, power-limited) 16 workers pushed
  # Firefox tests past their 15 s timeout, and a machine shared with other work gets the same.
  local busy cap
  busy=$(python3 -c '
import time
def snap():
    v = list(map(int, open("/proc/stat").readline().split()[1:9]))
    return sum(v) - v[3] - v[4], sum(v)
b0, t0 = snap(); time.sleep(1); b1, t1 = snap()
import os; print(round((b1 - b0) / max(1, t1 - t0) * os.cpu_count()))' 2>/dev/null || echo 0)
  cap=$(( cores < 10 ? cores : 10 ))
  export JE_BROWSER_WORKERS=${JE_BROWSER_WORKERS:-$(( cap - busy > 6 ? cap - busy : 6 ))}
  dir=$(mktemp -d)
  if [ -z "$long" ]; then
    step "BROWSER: npm run test:browser ($JE_BROWSER_WORKERS workers), failures vs $BASELINES/browser-failures.txt"
    PLAYWRIGHT_JSON_OUTPUT_NAME="$dir/results.json" npm run test:browser -- --reporter=list,json || rc=$?
    [ -s "$dir/results.json" ] || { echo "BROWSER: no JSON report written (exit $rc)" >&2; rm -rf "$dir"; false; }
    keep_report "$dir/results.json" browser-results.json
    browser_results "$dir/results.json" > "$dir/results"
  else
    # The long spec's 3 tests take ~100 test-seconds: 1 worker matches the rest's ~100 s below 12 workers; from 12, 2.
    local lw=${JE_BROWSER_LONG_WORKERS:-$(( JE_BROWSER_WORKERS >= 12 ? 2 : 1 ))} port2
    port2=$(free_port)
    step "BROWSER: npm run test:browser as two runs at once: $long ($lw workers, port $port2) and the rest ($(( JE_BROWSER_WORKERS - lw )) workers), failures vs $BASELINES/browser-failures.txt"
    JE_BROWSER_PART=long JE_BROWSER_LONG=$long JE_BROWSER_PORT=$port2 JE_BROWSER_WORKERS=$lw PLAYWRIGHT_JSON_OUTPUT_NAME="$dir/long.json" \
      npm run test:browser -- --reporter=list,json >"$dir/long.log" 2>&1 &
    pid=$!
    JE_BROWSER_PART=rest JE_BROWSER_LONG=$long JE_BROWSER_WORKERS=$(( JE_BROWSER_WORKERS - lw )) PLAYWRIGHT_JSON_OUTPUT_NAME="$dir/rest.json" \
      npm run test:browser -- --reporter=list,json || rc=$?
    wait "$pid" || rc2=$?
    step "BROWSER: the long run ($long), exit $rc2"
    cat "$dir/long.log" >&2
    [ -s "$dir/rest.json" ] && [ -s "$dir/long.json" ] || { echo "BROWSER: a JSON report is missing (exits $rc, $rc2)" >&2; rm -rf "$dir"; false; }
    keep_report "$dir/rest.json" browser-results.json
    keep_report "$dir/long.json" browser-results-long.json
    { browser_results "$dir/rest.json"; browser_results "$dir/long.json"; } > "$dir/results"
    if [ -n "$(cut -d' ' -f2- "$dir/results" | sort | uniq -d)" ]; then echo "BROWSER: a test ran in both runs" >&2; rm -rf "$dir"; false; fi
  fi
  new=$(sed -n 's/^FAIL //p' "$dir/results" | LC_ALL=C sort -u | LC_ALL=C comm -23 - "$BASELINES/browser-failures.txt")
  gone=$(sed -n 's/^FAIL //p' "$dir/results" | LC_ALL=C sort -u | LC_ALL=C comm -13 - "$BASELINES/browser-failures.txt")
  echo "BROWSER: $(wc -l < "$dir/results") tests, passed $(grep -c '^PASS ' "$dir/results" || true), failed $(grep -c '^FAIL ' "$dir/results" || true) (baseline list $(wc -l < "$BASELINES/browser-failures.txt")), skipped $(grep -c '^SKIP ' "$dir/results" || true)" >&2
  if [ -n "$gone" ]; then
    echo "BROWSER: note: listed in $BASELINES/browser-failures.txt but did not fail (remove it from the list):" >&2
    printf '  %s\n' "$gone" >&2
  fi
  rm -rf "$dir"
  if [ -n "$new" ]; then
    echo "BROWSER: $(printf '%s\n' "$new" | wc -l) failing test(s) not in $BASELINES/browser-failures.txt:" >&2
    printf '  %s\n' "$new" >&2
    false
  fi
)

gate_r() (
  set -e
  local pattern=$1
  step "R: stale references to /$pattern/"
  # git grep: 0 = matches (stale refs), 1 = none; anything else (e.g. a bad regex) is an error, not a pass.
  local rc=0
  git grep -nE "$pattern" -- . ':!artifacts' || rc=$?
  case $rc in
    1) return 0 ;;
    0) echo "R: stale references found" >&2; return 1 ;;
    *) echo "R: git grep failed (exit $rc)" >&2; return "$rc" ;;
  esac
)

gate_h() (
  set -e
  no_snapshot_updates
  local p
  # Unlike the backend.md loop (`|| break`, which ends the loop with status 0), a failed build fails the gate.
  for p in tests/poster/rendering/PosterTagsHarness.csproj tests/poster/pipeline/PosterTagsPipelineHarness.csproj tests/poster/parity/PosterTagParity/PosterTagParity.csproj; do
    step "H: build $p"
    dotnet build "$p" -c Release -p:JellyfinTarget=jf12
  done
  step "H: gen-resolution-data --check"
  node tests/poster/parity/gen-resolution-data.mjs --check
)

# stdout carries nothing; the dotnet log goes to stderr only on failure.
gate_bundle() (
  set -e
  local out log
  out=$(realpath -m "$1")
  log=$(mktemp)
  trap 'rm -f "$log"' EXIT
  rm -f "$out"
  if ! JE_BUNDLE_OUT="$out" dotnet test "$TESTS" -c Release --no-restore -p:JellyfinTarget=jf12 \
      --filter "FullyQualifiedName=JE.Tests.BundleDump.WritesServedBundleWhenRequested" >"$log" 2>&1; then
    cat "$log" >&2; false
  fi
  if [ ! -s "$out" ]; then
    cat "$log" >&2; echo "bundle: $out was not written (did the BundleDump test run?)" >&2; false
  fi
)

# Stable = without the bundle's own last line, `//# sourceMappingURL=bundle.js.map?v=<version>-<DLL mtime ticks>`, which
# changes on every plugin rebuild (ClientScriptBundle.cs). The ~183 per-module `//# sourceMappingURL=<module>.js.map`
# lines stay. Comment-stripped = stable minus every `// client/src/…` source comment (they are indented).
gate_bundle_hash() (
  set -e
  local map='^//# sourceMappingURL=bundle\.js\.map\?v='
  [ -f "$1" ] || { echo "bundle-hash: $1 not found" >&2; false; }
  [ "$(grep -cE "$map" "$1")" = 1 ] || { echo "bundle-hash: expected exactly one bundle.js.map?v= line in $1" >&2; false; }
  printf '%s %s\n' \
    "$(grep -vE "$map" "$1" | sha256sum | cut -d' ' -f1)" \
    "$(grep -vE "$map|^[[:space:]]*// client/src/" "$1" | sha256sum | cut -d' ' -f1)"
)

# canopy K1 bundle-size gate: the identity body of the in-process GET /JellyfinEnhanced/bundle.js (gate_bundle) must fit
# client/bundle-budget.json `limits`, raw and gzip -9 (tests/backend/Api/BundleBudgetTests.cs checks the same in T, and
# that the budget only rises with a reason). Brotli -q 11 (what the endpoint sends to browsers) is printed, not gated.
gate_size() (
  set -e
  local dir raw gzip br max_raw max_gzip rc=0
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  step "SIZE: served bundle vs client/bundle-budget.json"
  gate_bundle "$dir/bundle.js"
  raw=$(wc -c < "$dir/bundle.js")
  gzip=$(gzip -9 -n -c "$dir/bundle.js" | wc -c)
  max_raw=$(jq -e '.limits.rawBytes' client/bundle-budget.json)
  max_gzip=$(jq -e '.limits.gzipBytes' client/bundle-budget.json)
  br=$(if command -v brotli >/dev/null; then brotli -q 11 -c "$dir/bundle.js" | wc -c; else echo 'n/a (no brotli CLI)'; fi)
  echo "SIZE: raw $raw (budget $max_raw), gzip -9 $gzip (budget $max_gzip), brotli -q 11 $br" >&2
  if [ "$raw" -gt "$max_raw" ]; then echo "SIZE: raw $raw > budget $max_raw" >&2; rc=1; fi
  if [ "$gzip" -gt "$max_gzip" ]; then echo "SIZE: gzip -9 $gzip > budget $max_gzip" >&2; rc=1; fi
  if [ "$rc" != 0 ]; then
    echo "SIZE: make the bundle smaller, or raise the budget in a new client/bundle-budget.json history entry with a reason." >&2
  fi
  return "$rc"
)

# quick: the inner loop for the features a change touches (docs/feature-map.json). Not a merge gate: `all` (and
# `browser` for client changes) still run once on the final tree. Node failures are ratcheted by name only against
# baselines/npm-failures.txt, because a subset cannot meet the full-suite totals.
quick_map() { python3 - "$@" <<'PY'
import json, pathlib, sys
mode, args = sys.argv[1], sys.argv[2:]
features = json.load(open('docs/feature-map.json'))['features']
root = json.load(open('docs/feature-map.json'))['backendRoot']
if mode == 'features':                      # changed paths (arguments) -> feature names
    hit = []
    for p in args:
        if p.endswith(('.md', '.js', '.js.map')) or p.startswith(('docs/', 'artifacts/')) or p in (
                'client/generated-manifest.json', 'tests/docs/production-inventory.json'):
            continue
        best, size = None, 0
        for f in features:
            prefixes = list(f.get('client') or []) + [x for x in (f.get('tests') or {}).get('frontend', [])
                                                      if x.startswith('tests/frontend/features/')]
            if f.get('backend'):
                prefixes += [f"{root}/{f['backend']}", f"tests/backend/Features/{f['backend']}"]
            for pre in prefixes:
                if p.startswith(pre.rstrip('/') + '/') and len(pre) > size:
                    best, size = f['name'], len(pre)
        if best is None and p.startswith(('client/src/', 'Jellyfin.Plugin.JellyfinEnhanced/', 'tests/')):
            best = 'platform'
        if best and best not in hit:
            hit.append(best)
    print(' '.join(hit))
elif mode == 'tests':                       # feature names -> node test files
    names = set(args)
    unknown = names - {f['name'] for f in features}
    if unknown:
        sys.exit(f"quick: unknown feature(s) {sorted(unknown)}")
    dirs = {'tests/frontend/architecture', 'tests/frontend/guards'}
    for f in features:
        if f['name'] in names:
            dirs |= set((f.get('tests') or {}).get('frontend', []))
    print('\n'.join(sorted(str(p) for d in dirs for p in pathlib.Path(d).rglob('*.test.mjs'))))
elif mode == 'filter':                      # feature names -> dotnet filter
    parts = ['FullyQualifiedName~JE.Tests.Architecture'] + [
        f"FullyQualifiedName~JE.Tests.Features.{f['backend']}" for f in features if f['name'] in args and f.get('backend')]
    print('|'.join(parts))
PY
}

gate_quick() (
  set -e
  no_snapshot_updates
  local base changed feats dir rc=0 new
  base=$(change_base)
  changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)
  # (The paths go as arguments: quick_map's program is python's stdin, so a pipe into it would never be read.)
  # shellcheck disable=SC2086  # one path per word
  if [ $# -gt 0 ]; then feats="$*"; else feats=$(quick_map features $changed); fi
  step "QUICK: features ${feats:-(none; architecture and guards only)}"
  npm run --silent client:typecheck:fast      # tsc-rs, ~0.2 s, fails fast; TypeScript 6 checks next and decides
  npm run client:typecheck
  npm run client:build
  npm run inventory:rewrite
  dir=$(mktemp -d)
  # shellcheck disable=SC2086  # feature names are single words
  quick_map tests $feats > "$dir/files"
  # A recorded affected map adds the files whose traced inputs the change touches (a union: never fewer files than the
  # feature map gives) and the Playwright specs; the contract-boundary test (it reads almost every source) is left
  # to the gates. Without a map, or for a change the map calls global, the feature map alone decides.
  : > "$dir/specs"
  if [ -s node_modules/.cache/je-affected/map.json ]; then
    python3 tests/runner/affected.py select --json 2>/dev/null | python3 -c '
import json, sys
s = json.load(sys.stdin)
if s["all"]:
    print("QUICK: the affected map selects everything (" + s["all"] + "); the feature map decides", file=sys.stderr)
    sys.exit(0)
node = s["suites"].get("frontend", []) + s["suites"].get("client-build", [])
open(sys.argv[1], "a").write("".join(f + "\n" for f in node))
open(sys.argv[2], "w").write("".join(f + "\n" for f in s["suites"].get("browser", [])))
print(f"QUICK: the affected map adds {len(node)} node test file(s) and {len(s[\"suites\"].get(\"browser\", []))} spec(s)", file=sys.stderr)
' "$dir/files" "$dir/specs" || echo "QUICK: the affected map could not be read; the feature map decides" >&2
    LC_ALL=C sort -u -o "$dir/files" "$dir/files"
  fi
  step "QUICK: $(wc -l < "$dir/files") node test files (failures ratcheted by name vs $BASELINES/npm-failures.txt)"
  # shellcheck disable=SC2046
  env TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 node --test --test-timeout=300000 \
    --test-concurrency="${JE_TEST_CONCURRENCY:-$(( $(nproc) > 5 ? $(nproc) - 1 : 4 ))}" \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter="$ROOT/scripts/restructure-gates-reporter.mjs" --test-reporter-destination="$dir/results" \
    $(cat "$dir/files") || true
  [ -s "$dir/results" ] || { echo "QUICK: node wrote no results" >&2; rm -rf "$dir"; false; }
  new=$(sed -n 's/^FAIL //p' "$dir/results" | LC_ALL=C sort -u | LC_ALL=C comm -23 - "$BASELINES/npm-failures.txt")
  echo "QUICK: node $(grep -c '^PASS ' "$dir/results" || true) passed, $(grep -c '^FAIL ' "$dir/results" || true) failed" >&2
  if [ -n "$new" ]; then echo "QUICK: failing test(s) not in $BASELINES/npm-failures.txt:" >&2; printf '  %s\n' "$new" >&2; rc=1; fi
  if [ -s "$dir/specs" ]; then
    step "QUICK: $(wc -l < "$dir/specs") Playwright spec(s) the change can reach (chromium; failures vs $BASELINES/browser-failures.txt)"
    # shellcheck disable=SC2046
    JE_BROWSER_PORT="${JE_BROWSER_PORT:-$(free_port)}" node node_modules/.bin/playwright test --config tests/browser/playwright.config.cjs \
      --project=chromium --reporter=line $(cat "$dir/specs") || rc=1
  fi
  rm -rf "$dir"
  if printf '%s\n' "$changed" | grep -q '\.cs$'; then
    step "QUICK: dotnet tests for ${feats:-Architecture}"
    # shellcheck disable=SC2086
    dotnet test "$TESTS" -c Release --no-restore -p:JellyfinTarget=jf12 --filter "$(quick_map filter $feats)" || rc=1
  fi
  return "$rc"
)

# affected record: (re)build the affected map for HEAD (every test file run once under strace; ~5 min on 10 cores), which
# `quick` and the frontend lane of the gates then use. Do it on a clean base commit. `affected` alone runs `quick`.
gate_affected() (
  set -e
  no_snapshot_updates
  if [ "${1:-}" = record ]; then
    step "AFFECTED: recording the map for $(git rev-parse --short HEAD) (every test file once, traced)"
    python3 tests/runner/affected.py record
    return
  fi
  echo "affected: the inner loop is \`quick\`, which uses the affected map when one is recorded; running quick" >&2
  gate_quick
)

# baselines/jf12-digest.txt: `<tag> <RepoDigest>`; HOST runs `je up <name> <port> --image <tag>`.
gate_image() (
  set -e
  local tag digest current
  read -r tag digest < "$BASELINES/jf12-digest.txt"
  current=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag")
  if ! grep -qxF "$digest" <<<"$current"; then
    echo "image: $tag is now ${current:-<missing>}, baseline $digest. Restore it with: docker pull $digest && docker tag $digest $tag; never re-record it mid-restructure." >&2
    false
  fi
  echo "image: $tag = $digest" >&2
)

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

[ $# -ge 1 ] || usage
cmd=$1; shift
# One heavy gate at a time per machine. `all` keeps ~8.5 of 10 cores busy and needs up to ~6 GB, `browser` runs a
# worker per core; started side by side on a 10-core, 15 GB machine they fail on timeouts (RESULTS.md §8 of
# artifacts/restructure-plan/test-speed). So a heavy gate started while another runs (in any checkout, e.g. a caller
# that starts `all` and `browser` together) waits for it, then runs: the two finish in sequence instead of failing.
# The slot is its own lock file, never JE12_GATE_LOCK, so callers that hold the gate lock cannot deadlock on it.
# JE_GATE_HEAVY_LOCK moves it; JE_GATE_SIDE_BY_SIDE=1 skips the wait.
case "$cmd" in
  be|fe|all|browser)
    if [ -z "${JE_GATE_HEAVY_HELD:-}" ] && [ "${JE_GATE_SIDE_BY_SIDE:-}" != 1 ]; then
      heavy_lock=${JE_GATE_HEAVY_LOCK:-${TMPDIR:-/tmp}/je-restructure-gates-heavy.lock}
      export JE_GATE_HEAVY_HELD=1
      flock -n "$heavy_lock" true 2>/dev/null || echo "restructure-gates: another heavy gate is running on this machine; $cmd waits for it ($heavy_lock)" >&2
      exec flock --close "$heavy_lock" bash "$SELF" "$cmd" "$@"
    fi ;;
esac
# One gate run checks the same tree's types several times (the plugin build's VerifyJellyfinEnhancedClient target,
# client:check, client:build, the contract-boundary fixture): a passing check is cached for the rest of the run only
# (scripts/client-build.mjs typecheckCache). Each run gets a fresh directory, so a gate never reuses a result from
# before it started, whatever the caller's environment says.
case "$cmd" in
  be|fe|all)
    JE_TYPECHECK_CACHE_DIR=$(mktemp -d)
    export JE_TYPECHECK_CACHE_DIR
    trap 'rm -rf "$JE_TYPECHECK_CACHE_DIR"' EXIT
    ;;
  # The inner loop keeps its cache between runs (the merge gates never read it), so its typecheck and build share one check.
  quick|affected) export JE_TYPECHECK_CACHE_DIR="$ROOT/node_modules/.cache/je-typecheck" ;;
  *) unset JE_TYPECHECK_CACHE_DIR ;;
esac
case "$cmd" in
  be|fe|all|browser|h|inv|tool|size) [ $# -eq 0 ] || usage; "gate_$cmd" ;;
  r) [ $# -eq 1 ] && [ -n "$1" ] || usage; gate_r "$1" ;;
  bundle) [ $# -eq 1 ] && [ -n "$1" ] || usage; gate_bundle "$1" ;;
  bundle-hash) [ $# -eq 1 ] && [ -n "$1" ] || usage; gate_bundle_hash "$1"; exit 0 ;;
  image) [ $# -eq 0 ] || usage; gate_image ;;
  quick) gate_quick "$@" ;;
  affected) [ $# -le 1 ] || usage; gate_affected "$@" ;;
  *) usage ;;
esac
echo "restructure-gates: $cmd passed" >&2

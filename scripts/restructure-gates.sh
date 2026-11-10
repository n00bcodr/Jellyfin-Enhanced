#!/usr/bin/env bash
# Gates for the v12 restructure (artifacts/restructure-plan/PLAN.md "Gates", backend.md §4 "Commands",
# frontend.md §3 gate G). Each gate runs in a `set -e` subshell; the script exits non-zero on the first failure.
#
#   scripts/restructure-gates.sh be              backend B, G, T, F + INV + TOOL (T and the frontend suite run at once)
#   scripts/restructure-gates.sh fe              frontend gate G (includes INV and TOOL)
#   scripts/restructure-gates.sh all             be, then fe without a second frontend-suite run (merge points)
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
#   scripts/restructure-gates.sh quick [feature…] inner loop, not a merge gate: typecheck, client build, inventory, the
#                                                features' node tests + architecture + guards (new failures only), and
#                                                their dotnet tests + Architecture when a .cs file changed. Features
#                                                default to those the diff from $JE_BASE_REF (else
#                                                restructure/integration) touches.
#
# Pre-existing test failures are ratcheted, not fixed: a dotnet or node test run passes when every failing test is
# listed in baselines/{dotnet,npm}-failures.txt and the total and passed counts are >= baselines/{dotnet,npm}-tests.txt.
# The browser suite passes when every failing test is listed in baselines/browser-failures.txt.
#
# Run dotnet gates one worktree at a time on the 16 GB worker (PLAN.md "Worktrees and parallelism"). Inside `be` one
# dotnet build or test runs at a time; the node frontend suite runs beside T. JE_TEST_CONCURRENCY (node test files at
# once; default max(4, cores - 1)) and JE_BROWSER_WORKERS (Playwright workers; `browser` uses 6 unless set) tune them.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
BASELINES=artifacts/restructure-plan/baselines
PLUGIN=Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj
TESTS=tests/backend/JE.Tests.csproj

step() { printf '\n== %s\n' "$*" >&2; }

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
  local dir rc=0
  dir=$(mktemp -d)
  node tests/frontend/run.mjs --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter="$ROOT/scripts/restructure-gates-reporter.mjs" --test-reporter-destination="$dir/results" \
    | tee "$dir/out" || rc=$?
  [ -s "$dir/results" ] || { echo "frontend tests: no results written (node exit $rc)" >&2; rm -rf "$dir"; return 1; }
  rc=0
  ratchet "npm test" "$BASELINES/npm-failures.txt" \
    "$(awk '$1=="ℹ" && $2=="tests" {print $3}' "$BASELINES/npm-tests.txt")" \
    "$(awk '$1=="ℹ" && $2=="pass" {print $3}' "$BASELINES/npm-tests.txt")" \
    "$dir/results" "$(awk '$1=="ℹ" && $2=="tests" {print $3}' "$dir/out")" "$(awk '$1=="ℹ" && $2=="pass" {print $3}' "$dir/out")" || rc=$?
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
  if [ -d tests/backend/Architecture ]; then
    step "G: Architecture gates"
    dotnet test "$TESTS" -c Release --no-restore -p:JellyfinTarget=jf12 --filter "FullyQualifiedName~Architecture"
  else
    step "G: skipped (tests/backend/Architecture does not exist yet; added by backend S0)"
  fi
)

# T, plus the verify:rewrite backend part (coverage floors on T's results).
be_t() (
  set -e
  local res rc=0
  step "T: full backend suite (failure ratchet vs $BASELINES/dotnet-failures.txt, dotnet-tests.txt)"
  res=$(mktemp -d)
  dotnet test "$TESTS" -c Release --no-restore -p:JellyfinTarget=jf12 \
    --logger "trx;LogFileName=je.trx" --results-directory "$res" --collect:"XPlat Code Coverage" || rc=$?
  [ -s "$res/je.trx" ] || { echo "T: no TRX written (dotnet test exit $rc)" >&2; false; }
  trx_results "$res/je.trx" > "$res/results"
  ratchet "T (dotnet test)" "$BASELINES/dotnet-failures.txt" \
    "$(grep -oE 'Total: *[0-9]+' "$BASELINES/dotnet-tests.txt" | grep -oE '[0-9]+')" \
    "$(grep -oE 'Passed: *[0-9]+' "$BASELINES/dotnet-tests.txt" | grep -oE '[0-9]+')" \
    "$res/results" $(head -1 "$res/results")
  # `npm run verify:rewrite` (scripts/client-verify.mjs) = contracts:check, client:check, inventory:rewrite:check,
  # test:client-build, test:contract-boundary, test:frontend, then `tests/run.py backend` (dotnet test + coverage floors).
  # It stops at the first pre-existing failure, so F runs those parts here instead: test:frontend ratcheted, the dotnet
  # run reused from T, and its coverage floors checked on T's results.
  step "F: verify:rewrite backend part: coverage floors on T's results (tests/runner/coverage.py)"
  python3 tests/runner/coverage.py "$res"
  rm -rf "$res"
)

# T and the ratcheted frontend suite at the same time, each in its own subshell with its own log. The frontend suite
# runs no dotnet, so dotnet still builds and tests one process at a time. Both tails are printed; either failing fails.
be_t_and_frontend() (
  set -e
  local dir tpid fpid trc=0 frc=0
  dir=$(mktemp -d)
  step "T and F's frontend suite, concurrently (separate logs; tails below)"
  ( be_t ) >"$dir/t.log" 2>&1 &
  tpid=$!
  ( step "F: frontend suite (ratcheted)"; frontend_tests ) >"$dir/frontend.log" 2>&1 &
  fpid=$!
  wait "$tpid" || trc=$?
  wait "$fpid" || frc=$?
  step "T log: summary and tail (exit $trc)"
  grep -E '^(Passed|Failed)!|^T \(dotnet test\)|^  JE\.|"passed"' "$dir/t.log" >&2 || true
  if [ "$trc" = 0 ]; then tail -n 4 "$dir/t.log" >&2; else tail -n 150 "$dir/t.log" >&2; fi
  step "F frontend suite log: summary and tail (exit $frc)"
  grep -E '^ℹ (tests|pass|fail|duration_ms) ' "$dir/frontend.log" >&2 || true
  if [ "$frc" = 0 ]; then tail -n 4 "$dir/frontend.log" >&2; else tail -n 250 "$dir/frontend.log" >&2; fi
  rm -rf "$dir"
  [ "$trc" = 0 ] && [ "$frc" = 0 ]
)

# The rest of F: client-build tests, contracts, path readers.
be_f_rest() (
  set -e
  step "F: client-build tests + contracts + path readers"
  npm run test:client-build
  npm run contracts:check
  npm run test:contract-boundary
  npm run client:check
  npm run inventory:rewrite:check
)

gate_be() (
  set -e
  be_build_and_g
  be_t_and_frontend
  be_f_rest
  gate_inv
  gate_tool
)

gate_fe() ( set -e; fe_checks with-frontend-suite )

# $1 = with-frontend-suite | without-frontend-suite (`all`, where be already ran it).
fe_checks() (
  set -e
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
  if [ "$1" = with-frontend-suite ]; then frontend_tests; else step "FE G: npm test already ran in be"; fi
  step "FE G: component-scripts.json and client/entries output keys vs restructure-base"
  git diff --exit-code restructure-base -- Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json
  local f
  for f in client/entries/*.json; do
    diff <(git show "restructure-base:$f" | jq -S keys) <(jq -S keys "$f")
  done
)

# Merge points: be, then fe without running the frontend suite a second time. fe regenerates (client:build,
# inventory:rewrite); be's frontend-suite run covers fe's tree only if that leaves the working tree as it was.
gate_all() (
  set -e
  local before after
  gate_be
  before=$(tree_state)
  fe_checks without-frontend-suite
  after=$(tree_state)
  if [ "$before" != "$after" ]; then
    echo "all: fe's regeneration changed the working tree after be ran, so be's results do not cover it:" >&2
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
gate_browser() (
  set -e
  local dir rc=0 new gone
  export JE_BROWSER_WORKERS=${JE_BROWSER_WORKERS:-6}
  dir=$(mktemp -d)
  step "BROWSER: npm run test:browser ($JE_BROWSER_WORKERS workers), failures vs $BASELINES/browser-failures.txt"
  PLAYWRIGHT_JSON_OUTPUT_NAME="$dir/results.json" npm run test:browser -- --reporter=list,json || rc=$?
  [ -s "$dir/results.json" ] || { echo "BROWSER: no JSON report written (exit $rc)" >&2; rm -rf "$dir"; false; }
  browser_results "$dir/results.json" > "$dir/results"
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
if mode == 'features':                      # changed paths on stdin -> feature names
    hit = []
    for p in sys.stdin.read().split():
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
  if [ $# -gt 0 ]; then feats="$*"; else feats=$(printf '%s\n' "$changed" | quick_map features); fi
  step "QUICK: features ${feats:-(none; architecture and guards only)}"
  npm run client:typecheck
  npm run client:build
  npm run inventory:rewrite
  dir=$(mktemp -d)
  # shellcheck disable=SC2086  # feature names are single words
  quick_map tests $feats > "$dir/files"
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
  rm -rf "$dir"
  if printf '%s\n' "$changed" | grep -q '\.cs$'; then
    step "QUICK: dotnet tests for ${feats:-Architecture}"
    # shellcheck disable=SC2086
    dotnet test "$TESTS" -c Release --no-restore -p:JellyfinTarget=jf12 --filter "$(quick_map filter $feats)" || rc=1
  fi
  return "$rc"
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

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

[ $# -ge 1 ] || usage
cmd=$1; shift
case "$cmd" in
  be|fe|all|browser|h|inv|tool|size) [ $# -eq 0 ] || usage; "gate_$cmd" ;;
  r) [ $# -eq 1 ] && [ -n "$1" ] || usage; gate_r "$1" ;;
  bundle) [ $# -eq 1 ] && [ -n "$1" ] || usage; gate_bundle "$1" ;;
  bundle-hash) [ $# -eq 1 ] && [ -n "$1" ] || usage; gate_bundle_hash "$1"; exit 0 ;;
  image) [ $# -eq 0 ] || usage; gate_image ;;
  quick) gate_quick "$@" ;;
  *) usage ;;
esac
echo "restructure-gates: $cmd passed" >&2

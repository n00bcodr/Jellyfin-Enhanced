#!/usr/bin/env python3
"""Time a gate (or any command) N times and say where the time went.

    scripts/gate-timing.py run  [options] [--variant NAME=DIR ...] -- <command ...>
    scripts/gate-timing.py report <run dir> [<run dir> ...] [--top 30] [--md FILE]
    scripts/gate-timing.py compare <A run dir ...> --vs <B run dir ...>

`run` executes the command (default `scripts/restructure-gates.sh all`) under a /proc sampler and writes one directory
per run under --out: `run.json` (raw facts) and `summary.md`. With several --variant options the runs interleave
(A, B, A, B ...) in the variants' directories, so before/after comparisons see the same machine state.

What is measured, and how:
- Wall time: monotonic clock around the command.
- CPU time: exact for the whole run (getrusage of everything the command started; this process is a child subreaper,
  so orphans such as build servers are reaped here and counted). Per step and per process it comes from sampling
  /proc/<pid>/stat every --interval seconds: a process's own utime+stime, plus the CPU of children it reaped that the
  sampler never saw (cutime+cstime minus the sampled children). What sampling cannot attribute is reported as such.
- Steps: the gate script appends `<time> <subshell pid> <label>` to $JE_GATE_TRACE at every `step`; a process belongs
  to the latest step of its nearest ancestor subshell that had started a step when the process started.
- Parallelism: CPU seconds / wall seconds; utilisation: that divided by the cores this process may use.
- Load: load average, memory and the CPU used by processes that are not ours (foreign CPU) before and during the run.
  A run that starts with load1 above --max-load, or whose foreign CPU averages more than --max-foreign cores, is
  flagged `loaded` in run.json and in every report; `report` and `compare` leave flagged runs out unless --include-loaded.
- Test files and classes: node test files from their own processes (wall, CPU); dotnet test classes from the TRX the
  gate keeps ($JE_GATE_KEEP, per-test start/end; CPU is not separable inside one test host); Playwright files from the
  JSON report, with each worker's CPU (worker + its browsers) assigned to the test that worker was running at the time.

Locks: each run holds --lock (default $JE12_GATE_LOCK, else ~/.local/share/je12/gate.lock) with flock semantics, the
fd closed in children (= flock --close). If /home/jake/projects/.lenovo-quiet exists, a run waits until it is gone.
Build environment (same as je12): UseSharedCompilation=false, MSBUILDDISABLENODEREUSE=1, DOTNET_CLI_USE_MSBUILD_SERVER=0,
telemetry off, JE_UPDATE_SNAPSHOTS removed, a free JE_BROWSER_PORT.
"""
import argparse
import ctypes
import fcntl
import json
import os
import re
import resource
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HZ = os.sysconf('SC_CLK_TCK')
PAGE = os.sysconf('SC_PAGE_SIZE')
QUIET_FILE = Path('/home/jake/projects/.lenovo-quiet')
BUILD_ENV = {'UseSharedCompilation': 'false', 'MSBUILDDISABLENODEREUSE': '1', 'DOTNET_CLI_USE_MSBUILD_SERVER': '0',
             'DOTNET_CLI_TELEMETRY_OPTOUT': '1', 'DOTNET_NOLOGO': '1', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE': '1'}


def cores():
    return len(os.sched_getaffinity(0))


# /proc/<pid>/stat starttime counts clock ticks on the boot-time clock; /proc/stat btime is rounded to a second and
# drifts from the wall clock, so convert with the offset between the two clocks measured now.
BOOT = time.time() - time.clock_gettime(time.CLOCK_BOOTTIME)


def read_stat(pid):
    """-> (comm, ppid, utime, stime, cutime, cstime, start epoch, state) or None."""
    try:
        raw = open(f'/proc/{pid}/stat', 'rb').read().decode('utf-8', 'replace')
    except OSError:
        return None
    lp, rp = raw.find('('), raw.rfind(')')
    comm, rest = raw[lp + 1:rp], raw[rp + 2:].split()
    # rest[0] = state (field 3); field n is rest[n - 3]
    return (comm, int(rest[1]), int(rest[11]), int(rest[12]), int(rest[13]), int(rest[14]), BOOT + int(rest[19]) / HZ,
            rest[0])


def read_cmdline(pid):
    try:
        return [a.decode('utf-8', 'replace') for a in open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\0') if a]
    except OSError:
        return []


def read_environ_keys(pid, keys):
    try:
        out = {}
        for item in open(f'/proc/{pid}/environ', 'rb').read().split(b'\0'):
            k, _, v = item.partition(b'=')
            k = k.decode('utf-8', 'replace')
            if k in keys:
                out[k] = v.decode('utf-8', 'replace')
        return out
    except OSError:
        return {}


def machine_cpu():
    """-> (busy jiffies, total jiffies) over all CPUs."""
    f = open('/proc/stat').readline().split()[1:]
    v = list(map(int, f[:8]))
    idle = v[3] + v[4]
    return sum(v) - idle, sum(v)


def mem_available_mb():
    for line in open('/proc/meminfo'):
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) // 1024
    return None


def load_snapshot(seconds=2.0):
    """Machine state before a run: load averages, memory, and the CPU in use over `seconds`, with the busiest
    processes (so a flagged run says what was running)."""
    def all_cpu():
        out = {}
        for d in os.listdir('/proc'):
            if d.isdigit():
                s = read_stat(d)
                if s:
                    out[int(d)] = (s[0], s[2] + s[3])
        return out
    b0, t0 = machine_cpu()
    p0 = all_cpu()
    time.sleep(seconds)
    b1, t1 = machine_cpu()
    p1 = all_cpu()
    busy_cores = (b1 - b0) / max(1, (t1 - t0)) * os.cpu_count()
    top = sorted(((p1[p][1] - p0[p][1]) / HZ / seconds, p, p1[p][0]) for p in p1 if p in p0)[-5:][::-1]
    return {'load': list(os.getloadavg()), 'busy_cores': round(busy_cores, 2), 'mem_available_mb': mem_available_mb(),
            'top': [{'pid': p, 'comm': c, 'cores': round(x, 2)} for x, p, c in top if x > 0.05]}


class Proc:
    __slots__ = ('pid', 'ppid', 'ppid0', 'comm', 'argv', 'start', 'first', 'last', 'self', 'children', 'series', 'env', 'alive',
                 'execs')

    def __init__(self, pid, st, now):
        self.pid, self.comm, self.ppid, self.start = pid, st[0], st[1], st[6]
        self.ppid0 = st[1]           # the parent it had when first seen (an orphan is re-parented here later)
        self.argv, self.first, self.last, self.self, self.children = [], now, now, 0, 0
        self.series, self.env, self.alive, self.execs = [], {}, True, []


class Sampler(threading.Thread):
    """Samples the process tree under `root_pid` (and orphans re-parented to this process)."""

    def __init__(self, root_pid, interval):
        super().__init__(daemon=True)
        self.root, self.interval, self.me = root_pid, interval, os.getpid()
        self.procs = {}          # (pid, start) -> Proc
        self.ticks = []          # (t, our cpu jiffies cumulative, machine busy jiffies, machine total jiffies, load1)
        self.stop_event = threading.Event()

    def run(self):
        while not self.stop_event.is_set():
            self.sample()
            self.stop_event.wait(self.interval)
        self.sample()

    def sample(self):
        now = time.time()
        live = {}
        for d in os.listdir('/proc'):
            if not d.isdigit():
                continue
            pid = int(d)
            st = read_stat(pid)
            if st:
                live[pid] = st
        ours_pids = {p.pid for p in self.procs.values() if p.alive}
        # Fixpoint over parent links: the root, its descendants, and orphans re-parented to this subreaper.
        changed = True
        known = set(ours_pids) | {self.root}
        while changed:
            changed = False
            for pid, st in live.items():
                if pid not in known and (pid == self.root or st[1] in known or (st[1] == self.me and pid != self.me)):
                    known.add(pid)
                    changed = True
        seen = set()
        rss = 0
        for pid in known:
            st = live.get(pid)
            if not st:
                continue
            key = (pid, round(st[6], 2))
            p = self.procs.get(key)
            if p is None:
                p = self.procs[key] = Proc(pid, st, now)
            if p.comm != st[0] or not p.argv:
                p.comm, p.argv = st[0], read_cmdline(pid) or p.argv
                # A subshell that execs its last command keeps its pid: remember each image it ran.
                p.execs.append((now, p.comm, p.argv[:8]))
                if p.comm in ('node', 'MainThread') or (p.argv and p.argv[0].endswith('node')):
                    p.env = read_environ_keys(pid, ('TEST_WORKER_INDEX', 'TEST_PARALLEL_INDEX'))
            p.ppid, p.last = st[1], now
            cpu = st[2] + st[3]
            if cpu != p.self or not p.series:
                p.series.append((now, cpu))
            p.self, p.children = cpu, st[4] + st[5]
            seen.add(key)
            try:
                rss += int(open(f'/proc/{pid}/statm').read().split()[1])
            except (OSError, IndexError, ValueError):
                pass
        for key, p in self.procs.items():
            if p.alive and key not in seen:
                p.alive = False
        # Orphans re-parented to this subreaper are reaped as they exit (their CPU then lands in RUSAGE_CHILDREN);
        # the command itself is left to Popen.wait.
        for pid, st in live.items():
            if st[1] == self.me and st[7] == 'Z' and pid != self.root:
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
        busy, total = machine_cpu()
        ours = sum(p.self for p in self.procs.values())
        self.ticks.append((now, ours, busy, total, os.getloadavg()[0], rss * PAGE // (1 << 20), mem_available_mb()))


def set_subreaper():
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(36, 1, 0, 0, 0)   # PR_SET_CHILD_SUBREAPER
    except Exception:
        pass


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def git(cwd, *args):
    r = subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, text=True)
    return r.stdout.strip()


# ------------------------------------------------------------------------------------------------ one run

def one_run(cmd, cwd, out, args, label):
    out.mkdir(parents=True, exist_ok=True)
    while QUIET_FILE.exists():
        print(f'gate-timing: {QUIET_FILE} exists; waiting', file=sys.stderr, flush=True)
        time.sleep(30)
    lock_f = None
    if args.lock != 'none':
        lock_f = open(args.lock, 'a')   # Python fds are not inherited by children: flock --close semantics
        try:
            fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(f'gate-timing: waiting for {args.lock}', file=sys.stderr, flush=True)
            fcntl.flock(lock_f, fcntl.LOCK_EX)
    try:
        if args.wait_quiet:
            deadline = time.time() + args.wait_quiet
            while time.time() < deadline:
                snap = load_snapshot(2.0)
                # The load average lags by a minute and still holds the previous run; the 2 s CPU sample does not.
                if snap['busy_cores'] <= args.max_foreign:
                    break
                print(f"gate-timing: machine busy (load1 {snap['load'][0]:.1f}, {snap['busy_cores']} cores); waiting",
                      file=sys.stderr, flush=True)
                time.sleep(15)
        before = load_snapshot(2.0)
        env = dict(os.environ)
        env.pop('JE_UPDATE_SNAPSHOTS', None)
        env.update(BUILD_ENV)
        if args.node_dir:
            env['PATH'] = f'{args.node_dir}:{env["PATH"]}'
        env.setdefault('JE_BROWSER_PORT', str(free_port()))
        trace, keep = out / 'trace.tsv', out / 'reports'
        trace.write_text('')
        env['JE_GATE_TRACE'], env['JE_GATE_KEEP'] = str(trace), str(keep)
        for kv in args.env or []:
            k, _, v = kv.partition('=')
            env[k] = v
        ru0 = resource.getrusage(resource.RUSAGE_CHILDREN)
        log = open(out / 'output.log', 'w')
        t0, w0 = time.time(), time.monotonic()
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        sampler = Sampler(proc.pid, args.interval)
        sampler.start()
        rc = proc.wait()
        wall = time.monotonic() - w0
        t1 = time.time()
        # Anything still running belongs to the run (orphans re-parented here, or the session): stop and reap it.
        time.sleep(0.5)
        leftovers = [p for p in sampler.procs.values() if p.alive and p.pid != proc.pid]
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for p in leftovers:
            try:
                os.kill(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        time.sleep(1.0)
        for p in leftovers:
            try:
                os.kill(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG) == (0, 0):
                    time.sleep(0.1)
                    if not any(read_stat(p.pid) for p in leftovers):
                        break
            except ChildProcessError:
                break
        sampler.stop_event.set()
        sampler.join()
        ru1 = resource.getrusage(resource.RUSAGE_CHILDREN)
        log.close()
    finally:
        if lock_f:
            lock_f.close()
    after = {'load': list(os.getloadavg()), 'mem_available_mb': mem_available_mb()}
    cpu_exact = (ru1.ru_utime - ru0.ru_utime) + (ru1.ru_stime - ru0.ru_stime)
    ticks = sampler.ticks
    foreign = None
    if len(ticks) > 1:
        dbusy = ticks[-1][2] - ticks[0][2]
        dtotal = ticks[-1][3] - ticks[0][3]
        ours = ticks[-1][1] - ticks[0][1]
        n = os.cpu_count()
        foreign = max(0.0, (dbusy - ours) / max(1, dtotal) * n)
    loaded_reasons = []
    if before['load'][0] > args.max_load and before['busy_cores'] > args.max_foreign / 2:
        loaded_reasons.append(f"load1 {before['load'][0]:.2f} > {args.max_load} at start")
    if before['busy_cores'] > args.max_foreign:
        loaded_reasons.append(f"{before['busy_cores']} cores busy at start > {args.max_foreign}")
    if foreign is not None and foreign > args.max_foreign:
        loaded_reasons.append(f'foreign CPU {foreign:.2f} cores during the run > {args.max_foreign}')
    procs = []
    for p in sampler.procs.values():
        procs.append({'pid': p.pid, 'ppid': p.ppid, 'ppid0': p.ppid0, 'comm': p.comm, 'argv': p.argv[:40], 'start': p.start,
                      'first': p.first, 'last': p.last, 'self': p.self / HZ, 'children': p.children / HZ,
                      'env': p.env, 'execs': p.execs, 'series': [(round(t, 3), c) for t, c in p.series] if p.env or 'browser' in args.series else []})
    run = {'label': label, 'cmd': cmd, 'cwd': str(cwd), 'git': git(cwd, 'rev-parse', 'HEAD'),
           'dirty': bool(git(cwd, 'status', '--porcelain')), 'host': socket.gethostname(), 'cores': cores(),
           'cpu_count': os.cpu_count(), 'start': t0, 'end': t1, 'wall': wall, 'rc': rc, 'cpu_exact': cpu_exact,
           'max_rss_mb': ru1.ru_maxrss // 1024, 'before': before, 'after': after,
           'foreign_cores': None if foreign is None else round(foreign, 3), 'loaded': loaded_reasons,
           'leftovers': [{'pid': p.pid, 'comm': p.comm, 'argv': p.argv[:6]} for p in leftovers],
           'interval': args.interval, 'hz': HZ,
           'ticks': [(round(x[0], 3), x[1], x[2], x[3], round(x[4], 2), *x[5:]) for x in ticks],
           'trace': [line.split('\t', 2) for line in trace.read_text().splitlines() if line.count('\t') >= 2],
           'procs': procs}
    (out / 'run.json').write_text(json.dumps(run))
    analysis = analyse(run, out)
    (out / 'analysis.json').write_text(json.dumps(analysis, indent=1))
    (out / 'summary.md').write_text(render([analysis], top=args.top))
    flag = f" LOADED ({'; '.join(loaded_reasons)})" if loaded_reasons else ''
    print(f'gate-timing: {label}: rc {rc}, wall {wall:.1f} s, CPU {cpu_exact:.1f} s '
          f'(x{cpu_exact / wall:.2f} of {cores()} cores), foreign {run["foreign_cores"]} cores{flag} -> {out}',
          file=sys.stderr, flush=True)
    return analysis


# ------------------------------------------------------------------------------------------------ analysis

def classify(argv, comm):
    a = ' '.join(argv)
    base = os.path.basename(argv[0]) if argv else comm
    if 'testhost' in a:
        return 'dotnet testhost'
    if 'datacollector' in a:
        return 'dotnet datacollector'
    if 'MSBuild.dll' in a and '/nodemode' in a:
        return 'dotnet msbuild node'
    if comm.startswith('npm'):
        return 'npm'
    if 'VBCSCompiler' in a or 'csc.dll' in a or base == 'csc' or comm == 'csc':
        return 'dotnet compiler'
    if base == 'dotnet' or comm == 'dotnet':
        if len(argv) > 1 and argv[1] in ('build', 'test', 'run', 'restore', 'exec'):
            return f'dotnet {argv[1]}'
        return 'dotnet other'
    if comm.startswith('ClientContracts') or 'ClientContracts' in base:
        return 'dotnet ClientContracts'
    if 'chrom' in a.lower() or comm in ('chrome', 'chrome_crashpad', 'headless_shell'):
        return 'browser chromium'
    if 'firefox' in a.lower() or comm in ('firefox', 'firefox-bin', 'Web Content', 'Isolated Web Co', 'Socket Process',
                                           'RDD Process', 'Utility Process', 'forkserver', 'WebExtensions'):
        return 'browser firefox'
    if base == 'esbuild' or comm == 'esbuild':
        return 'esbuild'
    if base == 'node' or comm in ('node', 'MainThread'):
        if re.search(r'\.test\.mjs$', argv[-1] if argv else ''):
            return 'node test file'
        if 'server.cjs' in a:
            return 'browser fixture server'
        if 'playwright' in a:
            return 'playwright'
        if 'client-build.mjs' in a:
            return 'client-build (tsc/esbuild)'
        if '--test' in a:
            return 'node --test runner'
        if 'npm-cli.js' in a or base == 'npm':
            return 'npm'
        return 'node other'
    if base.startswith('python') or comm.startswith('python'):
        return 'python'
    if base in ('git',) or comm == 'git':
        return 'git'
    if base in ('bash', 'sh') or comm in ('bash', 'sh'):
        return 'shell'
    return 'other'


def analyse(run, out):
    procs = run['procs']
    by_pid = {}
    for p in procs:
        by_pid.setdefault(p['pid'], []).append(p)

    def parent_of(p):
        cands = [q for q in by_pid.get(p.get('ppid0', p['ppid']), []) if q['start'] <= p['start'] + 0.05]
        return max(cands, key=lambda q: q['start']) if cands else None

    for p in procs:
        p['cat'] = classify(p['argv'], p['comm'])
        execs = p.get('execs') or []
        # A gate subshell that exec'd its last command: still a shell for steps and parents; the command it became
        # is listed from the exec on.
        p['was_shell'] = bool(execs) and classify(execs[0][2], execs[0][1]) == 'shell'
        p['exec_at'] = execs[-1][0] if len(execs) > 1 else p['start']
    # Children's reaped CPU that was never sampled: cutime - sum of sampled direct children's (self + children).
    kids = {}
    for p in procs:
        par = parent_of(p)
        p['_parent'] = par
        if par is not None:
            kids.setdefault(id(par), []).append(p)
    # tree(p) = self + max(reaped children's CPU as the kernel reports it, sum of the sampled children's trees): a
    # child's own counter misses what it reaped after its last sample, so the larger of the two is used, and what the
    # kernel reports beyond the sampled children (processes too short to sample) is attributed to p itself.
    roots = [p for p in procs if p['_parent'] is None]
    stack = [(r, False) for r in roots]
    while stack:                       # post-order, iteratively (deep trees)
        p, done = stack.pop()
        ks = kids.get(id(p), [])
        if not done:
            stack.append((p, True))
            stack.extend((k, False) for k in ks)
            continue
        sub = sum(c['tree'] for c in ks)
        p['tree'] = p['self'] + max(p['children'], sub)
        p['unsampled'] = max(0.0, p['children'] - sub)
        p['cpu'] = p['self'] + p['unsampled']
    # Steps: per subshell pid, its markers in order.
    markers = {}
    t_start = run['start']
    step_names, seen_label, marker_time = [], {}, {}
    for t, pid, label in sorted(run['trace'], key=lambda x: float(x[0])):
        seen_label[label] = seen_label.get(label, 0) + 1
        name = label if seen_label[label] == 1 else f'{label} [#{seen_label[label]}]'
        markers.setdefault(int(pid), []).append((float(t), name))
        step_names.append(name)
        marker_time[name] = float(t)

    def step_of(p):
        own = markers.get(p['pid'])
        if own and p['was_shell']:
            act = [label for t, label in own if t <= p['exec_at'] + 0.02]
            if act:
                return act[-1]
        q = p
        while q is not None:
            ms = markers.get(q['pid'])
            if ms and q is not p:
                act = [label for t, label in ms if t <= p['start'] + 0.02]
                if act:
                    return act[-1]
            q = q['_parent']
        return '(outside any step)'

    steps = {}
    for p in procs:
        p['step'] = step_of(p)
        s = steps.setdefault(p['step'], {'cpu': 0.0, 'start': None, 'end': None, 'cats': {}, 'procs': 0})
        s['cpu'] += p['cpu']
        s['cats'][p['cat']] = s['cats'].get(p['cat'], 0.0) + p['cpu']
        s['procs'] += 1
    # Wall per step: from its marker to the end of the last process attributed to it.
    for name, s in steps.items():
        ps = [p for p in procs if p['step'] == name]
        s['start'] = marker_time.get(name, min(p['start'] for p in ps))
        # The step's subshells live as long as their caller needs them; the work is what they run.
        work = [p for p in ps if p['cat'] != 'shell'] or ps
        s['end'] = max(p['last'] for p in work)
        s['wall'] = max(0.0, s['end'] - s['start'])
    # Idle: ticks where our tree used less than 0.3 cores.
    t_end = t_start + run['wall']
    ticks = [t for t in run['ticks'] if t[0] <= t_end + run['interval']]
    idle = 0.0
    series = []
    for (t0, o0, *_), (t1, o1, *_) in zip(ticks, ticks[1:]):
        rate = (o1 - o0) / run['hz'] / max(1e-6, t1 - t0)
        series.append((round(t1 - t_start, 2), round(rate, 2)))
        if rate < 0.3:
            idle += t1 - t0
    for name, s in steps.items():
        s['idle'] = 0.0
        for (t0, o0, *_), (t1, o1, *_) in zip(ticks, ticks[1:]):
            if t1 <= s['start'] or t0 >= s['end']:
                continue
            rate = (o1 - o0) / run['hz'] / max(1e-6, t1 - t0)
            if rate < 0.3:
                s['idle'] += t1 - t0
    # Commands: the processes that steps start directly (children of a gate subshell), grouped by command line.
    cmds = {}
    for p in procs:
        par = p['_parent']
        if p['was_shell'] and p['cat'] != 'shell':
            pass                       # an exec'd last command: listed from its exec on
        elif par is None or not (par['cat'] == 'shell' or par['was_shell']) or p['cat'] == 'shell':
            continue
        sig = ' '.join(p['argv'][:4])[:140]
        if p['was_shell']:
            total = sum(d['cpu'] for d in descendants(p, kids) if d['start'] >= p['exec_at'] - 0.05) + p['self']
        else:
            total = p['cpu'] + sum(d['cpu'] for d in descendants(p, kids))
        c = cmds.setdefault(sig, {'count': 0, 'wall': 0.0, 'cpu': 0.0, 'steps': []})
        c['count'] += 1
        c['wall'] += p['last'] - p['exec_at']
        c['cpu'] += total
        if p['step'] not in c['steps']:
            c['steps'].append(p['step'])
    cats = {}
    for p in procs:
        cats[p['cat']] = cats.get(p['cat'], 0.0) + p['cpu']
    # Node test files.
    node_files = []
    for p in procs:
        if p['cat'] == 'node test file':
            f = os.path.relpath(p['argv'][-1], run['cwd']) if p['argv'][-1].startswith('/') else p['argv'][-1]
            node_files.append({'file': f, 'wall': p['last'] - p['start'], 'cpu': p['cpu'] + sum(d['cpu'] for d in descendants(p, kids)),
                               'start': p['start'] - t_start})
    runner = [p for p in procs if p['cat'] == 'node --test runner']
    reports = out / 'reports'
    trxs = sorted(reports.glob('T*.trx'))
    dotnet_classes, dotnet_meta = trx_classes(trxs) if trxs else ([], {})
    if dotnet_meta:
        hosts = [p for p in procs if p['cat'] == 'dotnet testhost']
        if hosts:
            h = max(hosts, key=lambda p: p['last'] - p['start'])
            dotnet_meta['testhost_wall'] = h['last'] - h['start']
            dotnet_meta['testhost_cpu'] = h['cpu']
            dotnet_meta['testhost_start_to_first_test'] = dotnet_meta['first_test'] - h['start']
    browser_files, browser_meta = ([], {})
    if (reports / 'browser-results.json').exists():
        browser_files, browser_meta = playwright_files(reports / 'browser-results.json', procs, kids, run)
    attributed = sum(p['cpu'] for p in procs)
    rss_series = [x[5] for x in ticks if len(x) > 5]
    avail_series = [x[6] for x in ticks if len(x) > 6 and x[6] is not None]
    return {'label': run['label'], 'git': run['git'], 'dirty': run['dirty'], 'host': run['host'], 'cores': run['cores'],
            'wall': run['wall'], 'rc': run['rc'], 'cpu': run['cpu_exact'], 'attributed_cpu': attributed,
            'before': run['before'], 'foreign_cores': run['foreign_cores'], 'loaded': run['loaded'],
            'leftovers': run['leftovers'], 'idle': idle, 'max_rss_mb': run['max_rss_mb'],
            'peak_tree_rss_mb': max(rss_series) if rss_series else None,
            'min_mem_available_mb': min(avail_series) if avail_series else None,
            'steps': {k: {kk: vv for kk, vv in v.items()} for k, v in steps.items()},
            'step_order': [n for n in step_names if n in steps] + [n for n in steps if n not in step_names],
            'categories': cats, 'commands': cmds, 'node_files': node_files,
            'node_runner_wall': sum(p['last'] - p['start'] for p in runner),
            'dotnet_classes': dotnet_classes, 'dotnet': dotnet_meta,
            'browser_files': browser_files, 'browser': browser_meta, 'cpu_series': series, 'start': run['start']}


def descendants(p, kids):
    out, stack = [], list(kids.get(id(p), []))
    while stack:
        q = stack.pop()
        out.append(q)
        stack.extend(kids.get(id(q), []))
    return out


def trx_classes(paths):
    """Classes over one or more TRX files (T may run as several test hosts, one TRX each)."""
    ns = '{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}'
    roots = [ET.parse(p).getroot() for p in (paths if isinstance(paths, list) else [paths])]
    defs = {}
    for root in roots:
        for d in root.iter(f'{ns}UnitTest'):
            tm = d.find(f'{ns}TestMethod')
            defs[d.get('id')] = tm.get('className') if tm is not None else '?'

    def ts(s):
        # 2026-11-10T10:41:02.1234567+08:00 -> epoch
        from datetime import datetime
        s = re.sub(r'(\.\d{6})\d+', r'\1', s)
        return datetime.fromisoformat(s).timestamp()
    cls = {}
    first, last, total_dur, n = None, None, 0.0, 0
    for r in (x for root in roots for x in root.iter(f'{ns}UnitTestResult')):
        c = defs.get(r.get('testId'), '?')
        st, en = ts(r.get('startTime')), ts(r.get('endTime'))
        h, m, s = r.get('duration', '0:0:0').split(':')
        dur = int(h) * 3600 + int(m) * 60 + float(s)
        e = cls.setdefault(c, {'class': c, 'tests': 0, 'duration': 0.0, 'start': st, 'end': en})
        e['tests'] += 1
        e['duration'] += dur
        e['start'], e['end'] = min(e['start'], st), max(e['end'], en)
        first = st if first is None else min(first, st)
        last = en if last is None else max(last, en)
        total_dur += dur
        n += 1
    for e in cls.values():
        e['span'] = e['end'] - e['start']
    times = roots[0].find(f'{ns}Times')
    return sorted(cls.values(), key=lambda e: -e['duration']), {
        'tests': n, 'first_test': first, 'last_test': last, 'test_span': (last - first) if first else 0,
        'sum_durations': total_dur, 'trx_start': ts(times.get('start')) if times is not None else None}


def playwright_files(path, procs, kids, run):
    data = json.load(open(path))
    root_dir = data['config']['rootDir']
    tests = []

    def walk(suite):
        for spec in suite.get('specs', []):
            for t in spec['tests']:
                for r in t.get('results', []):
                    from datetime import datetime
                    st = datetime.fromisoformat(r['startTime'].replace('Z', '+00:00')).timestamp()
                    tests.append({'file': os.path.relpath(os.path.join(root_dir, spec['file']), run['cwd']),
                                  'project': t['projectName'], 'worker': r.get('workerIndex'),
                                  'parallel': r.get('parallelIndex'), 'start': st, 'dur': r['duration'] / 1000.0,
                                  'status': r.get('status')})
        for c in suite.get('suites', []):
            walk(c)
    for s in data['suites']:
        walk(s)
    # Worker processes by TEST_WORKER_INDEX; their CPU series plus their descendants'.
    # Worker processes (playwright/lib/common/process.js under the runner): the dispatcher numbers workers in the order
    # it creates them, and it creates each with a synchronous spawn, so start order gives TEST_WORKER_INDEX (the
    # worker sets that variable itself at runtime, so /proc/<pid>/environ does not show it).
    workers = {}
    wprocs = sorted((p for p in procs if p['cat'] == 'playwright' and any(a.endswith('common/process.js') for a in p['argv'])),
                    key=lambda p: p['start'])
    for i, p in enumerate(wprocs):
        workers.setdefault(i, []).append(p)
    by_worker = {}
    for t in tests:
        by_worker.setdefault(t['worker'], []).append(t)
    for v in by_worker.values():
        v.sort(key=lambda t: t['start'])
    files = {}
    overhead_cpu = 0.0
    for t in tests:
        f = files.setdefault((t['file'], t['project']), {'file': t['file'], 'project': t['project'], 'tests': 0,
                                                         'duration': 0.0, 'cpu': 0.0})
        f['tests'] += 1
        f['duration'] += t['dur']
    browser_launch = []
    for wi, ws in workers.items():
        ts_ = by_worker.get(wi, [])
        for w in ws:
            tree = [w] + descendants(w, kids)
            for q in tree:
                prev_t, prev_c = q['start'], 0
                for t, c in q['series']:
                    d = (c - prev_c) / run['hz']
                    mid = (prev_t + t) / 2
                    owner = next((x for x in ts_ if x['start'] - 0.05 <= mid <= x['start'] + x['dur'] + 0.05), None)
                    if owner is None:
                        overhead_cpu += d
                    else:
                        files[(owner['file'], owner['project'])]['cpu'] += d
                    prev_t, prev_c = t, c
            browsers = [q for q in tree if q['cat'].startswith('browser') and q['_parent'] is w]
            for b in browsers:
                first = min((x['start'] for x in ts_ if x['start'] >= b['start']), default=None)
                browser_launch.append({'worker': wi, 'kind': b['cat'], 'start_to_first_test': (first - b['start']) if first else None})
    web = [p for p in procs if p['cat'] == 'browser fixture server']
    first_test = min((t['start'] for t in tests), default=None)
    meta = {'tests': len(tests), 'workers': len(workers), 'worker_overhead_cpu': overhead_cpu,
            'first_test_after_start': (first_test - run['start']) if first_test else None,
            'sum_durations': sum(t['dur'] for t in tests),
            'by_project': {}, 'browser_launches': len(browser_launch),
            'median_launch_to_first_test': statistics.median([b['start_to_first_test'] for b in browser_launch if b['start_to_first_test'] is not None]) if browser_launch else None,
            'fixture_server_cpu': sum(p['cpu'] for p in web)}
    for t in tests:
        b = meta['by_project'].setdefault(t['project'], {'tests': 0, 'duration': 0.0})
        b['tests'] += 1
        b['duration'] += t['dur']
    return sorted(files.values(), key=lambda f: -f['duration']), meta


# ------------------------------------------------------------------------------------------------ reports

def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def spread(xs):
    xs = [x for x in xs if x is not None]
    return (min(xs), max(xs)) if xs else (None, None)


def fmt(x, nd=1):
    return '-' if x is None else f'{x:.{nd}f}'


def render(analyses, top=30, include_loaded=False):
    used = [a for a in analyses if include_loaded or not a['loaded']] or analyses
    a0 = used[0]
    n, c = len(used), a0['cores']
    L = []
    L.append(f"# Timing: {a0['label']} ({n} run{'s' if n > 1 else ''}, {a0['host']}, {c} cores, commit {a0['git'][:10]}{' +dirty' if a0['dirty'] else ''})\n")
    flagged = [a for a in analyses if a['loaded']]
    if flagged:
        L.append(f"Runs flagged as started or run under load ({'included' if include_loaded else 'left out'}): "
                 + '; '.join(f"{a['label']} ({', '.join(a['loaded'])})" for a in flagged) + '\n')
    walls = [a['wall'] for a in used]
    cpus = [a['cpu'] for a in used]
    lo, hi = spread(walls)
    L.append('| | median | min | max |\n|---|---:|---:|---:|')
    L.append(f'| wall s | {fmt(med(walls))} | {fmt(lo)} | {fmt(hi)} |')
    lo2, hi2 = spread(cpus)
    L.append(f'| CPU s | {fmt(med(cpus))} | {fmt(lo2)} | {fmt(hi2)} |')
    L.append(f"| parallelism (CPU/wall) | {fmt(med([a['cpu'] / a['wall'] for a in used]), 2)} | | |")
    L.append(f"| core utilisation | {fmt(100 * med([a['cpu'] / a['wall'] / c for a in used]), 0)}% | | |")
    L.append(f"| idle (our tree < 0.3 cores) s | {fmt(med([a['idle'] for a in used]))} | | |")
    L.append(f"| CPU attributed by sampling | {fmt(100 * med([a['attributed_cpu'] / max(1e-6, a['cpu']) for a in used]), 0)}% | | |")
    L.append(f"| peak RSS of the run's processes, MB | {fmt(med([a.get('peak_tree_rss_mb') for a in used]), 0)} | | |")
    L.append(f"| lowest MemAvailable during the run, MB | {fmt(med([a.get('min_mem_available_mb') for a in used]), 0)} | | |")
    L.append(f"| exit codes | {', '.join(str(a['rc']) for a in used)} | | |")
    L.append(f"| load1 at start | {', '.join(fmt(a['before']['load'][0], 2) for a in used)} | | |")
    L.append(f"| foreign CPU during run (cores) | {', '.join(fmt(a['foreign_cores'], 2) for a in used)} | | |\n")
    # Steps
    names = []
    for a in used:
        for s in a['step_order']:
            if s not in names:
                names.append(s)
    L.append('## Steps (in order; wall = marker to the end of its last process)\n')
    L.append('| step | wall s | CPU s | parallelism | idle s | top CPU consumers |\n|---|---:|---:|---:|---:|---|')
    for s in names:
        ws = [a['steps'][s]['wall'] for a in used if s in a['steps']]
        cs = [a['steps'][s]['cpu'] for a in used if s in a['steps']]
        ids = [a['steps'][s]['idle'] for a in used if s in a['steps']]
        cats = {}
        for a in used:
            for k, v in a['steps'].get(s, {}).get('cats', {}).items():
                cats[k] = cats.get(k, 0) + v / len(used)
        topc = ', '.join(f'{k} {v:.0f}' for k, v in sorted(cats.items(), key=lambda kv: -kv[1])[:3] if v >= 0.5)
        w = med(ws)
        L.append(f"| {s[:90]} | {fmt(w)} | {fmt(med(cs))} | {fmt(med(cs) / w if w else None, 2)} | {fmt(med(ids))} | {topc} |")
    L.append('\n## CPU by process kind (median CPU s)\n')
    L.append('| kind | CPU s |\n|---|---:|')
    kinds = {k for a in used for k in a['categories']}
    for k in sorted(kinds, key=lambda k: -(med([a['categories'].get(k, 0) for a in used]) or 0)):
        v = med([a['categories'].get(k, 0) for a in used])
        if v and v >= 0.5:
            L.append(f'| {k} | {v:.1f} |')
    L.append('\n## Commands the steps run (repeated work shows as count > 1 or the same command in several steps)\n')
    L.append('| command | runs per gate | wall s (sum) | CPU s (sum, with children) | steps |\n|---|---:|---:|---:|---|')
    cmds = {}
    for a in used:
        for k, v in a['commands'].items():
            e = cmds.setdefault(k, {'count': [], 'wall': [], 'cpu': [], 'steps': v['steps']})
            e['count'].append(v['count'])
            e['wall'].append(v['wall'])
            e['cpu'].append(v['cpu'])
    for k, e in sorted(cmds.items(), key=lambda kv: -med(kv[1]['wall'])):
        if med(e['wall']) < 0.3:
            continue
        L.append(f"| `{k}` | {fmt(med(e['count']), 0)} | {fmt(med(e['wall']))} | {fmt(med(e['cpu']))} | {'; '.join(x[:40] for x in e['steps'])} |")
    nf = {}
    for a in used:
        for f in a['node_files']:
            e = nf.setdefault(f['file'], {'wall': [], 'cpu': []})
            e['wall'].append(f['wall'])
            e['cpu'].append(f['cpu'])
    if nf:
        tot_w = sum(med(e['wall']) for e in nf.values())
        tot_c = sum(med(e['cpu']) for e in nf.values())
        L.append(f'\n## Node test files: {len(nf)} sampled, sum of wall {tot_w:.0f} s, sum of CPU {tot_c:.0f} s; slowest {top}\n')
        L.append('| file | wall s | CPU s | CPU/wall |\n|---|---:|---:|---:|')
        for k, e in sorted(nf.items(), key=lambda kv: -med(kv[1]['wall']))[:top]:
            w, cc = med(e['wall']), med(e['cpu'])
            L.append(f'| {k} | {w:.1f} | {cc:.1f} | {cc / w if w else 0:.2f} |')
    dn = {}
    for a in used:
        for e in a['dotnet_classes']:
            d = dn.setdefault(e['class'], {'tests': e['tests'], 'duration': [], 'span': []})
            d['duration'].append(e['duration'])
            d['span'].append(e['span'])
    if dn:
        dm = [a['dotnet'] for a in used if a['dotnet']]
        L.append(f"\n## dotnet test classes: {len(dn)} classes, {dm[0]['tests']} tests; sum of test durations "
                 f"{fmt(med([d['sum_durations'] for d in dm]))} s over a test span of {fmt(med([d['test_span'] for d in dm]))} s; "
                 f"test host wall {fmt(med([d.get('testhost_wall') for d in dm]))} s, CPU {fmt(med([d.get('testhost_cpu') for d in dm]))} s, "
                 f"host start to first test {fmt(med([d.get('testhost_start_to_first_test') for d in dm]))} s; slowest {top}\n")
        L.append('| class | tests | sum of durations s | first start to last end s |\n|---|---:|---:|---:|')
        for k, e in sorted(dn.items(), key=lambda kv: -med(kv[1]['duration']))[:top]:
            L.append(f"| {k} | {e['tests']} | {med(e['duration']):.2f} | {med(e['span']):.2f} |")
    bf = {}
    for a in used:
        for f in a['browser_files']:
            e = bf.setdefault((f['file'], f['project']), {'tests': f['tests'], 'duration': [], 'cpu': []})
            e['duration'].append(f['duration'])
            e['cpu'].append(f['cpu'])
    if bf:
        bm = [a['browser'] for a in used if a['browser']]
        L.append(f"\n## Playwright: {bm[0]['tests']} tests, {bm[0]['workers']} worker processes, {bm[0]['browser_launches']} browser launches; "
                 f"sum of test durations {fmt(med([b['sum_durations'] for b in bm]))} s; first test {fmt(med([b['first_test_after_start'] for b in bm]))} s after the gate started; "
                 f"worker CPU outside tests (startup, fixtures, teardown) {fmt(med([b['worker_overhead_cpu'] for b in bm]))} s; "
                 f"browser launch to first test (median) {fmt(med([b['median_launch_to_first_test'] for b in bm]), 2)} s\n")
        L.append('| project | tests | sum of durations s |\n|---|---:|---:|')
        for p_, v in bm[0]['by_project'].items():
            L.append(f"| {p_} | {v['tests']} | {med([b['by_project'].get(p_, {}).get('duration') for b in bm]):.1f} |")
        L.append(f'\nSlowest {top} files per project (duration = sum of its tests\' durations; CPU = worker + browser CPU while its tests ran)\n')
        L.append('| file | project | tests | duration s | CPU s |\n|---|---|---:|---:|---:|')
        for (f_, p_), e in sorted(bf.items(), key=lambda kv: -med(kv[1]['duration']))[:top]:
            L.append(f"| {f_} | {p_} | {e['tests']} | {med(e['duration']):.1f} | {med(e['cpu']):.1f} |")
    return '\n'.join(L) + '\n'


def load_analyses(dirs):
    out = []
    for d in dirs:
        p = Path(d)
        if (p / 'analysis.json').exists():
            out.append(json.load(open(p / 'analysis.json')))
        elif (p / 'run.json').exists():
            a = analyse(json.load(open(p / 'run.json')), p)
            (p / 'analysis.json').write_text(json.dumps(a, indent=1))
            out.append(a)
    return out


def compare(a_dirs, b_dirs, include_loaded=False):
    A = [a for a in load_analyses(a_dirs) if include_loaded or not a['loaded']]
    B = [a for a in load_analyses(b_dirs) if include_loaded or not a['loaded']]
    wa, wb = [a['wall'] for a in A], [b['wall'] for b in B]
    ma, mb = med(wa), med(wb)
    la, ha = spread(wa)
    lb, hb = spread(wb)
    # Noise: the larger of the two spreads (max - min). A difference counts when it exceeds that and the ranges do not overlap.
    noise = max(ha - la, hb - lb)
    sep = hb < la or ha < lb
    lines = [f"A: n={len(A)} median {ma:.1f} s (min {la:.1f}, max {ha:.1f}); runs {', '.join(f'{x:.1f}' for x in wa)}",
             f"B: n={len(B)} median {mb:.1f} s (min {lb:.1f}, max {hb:.1f}); runs {', '.join(f'{x:.1f}' for x in wb)}",
             f"difference B - A: {mb - ma:+.1f} s ({100 * (mb - ma) / ma:+.1f}%); noise (largest spread) {noise:.1f} s; "
             f"ranges {'do not overlap' if sep else 'overlap'} -> {'REAL' if sep and abs(mb - ma) > noise else 'within noise'}",
             f"CPU: A {med([a['cpu'] for a in A]):.0f} s, B {med([b['cpu'] for b in B]):.0f} s"]
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run')
    r.add_argument('--runs', type=int, default=1)
    r.add_argument('--out', type=Path, default=Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'je-gate-timing')
    r.add_argument('--label', default=None)
    r.add_argument('--variant', action='append', default=[], help='NAME=DIR; runs interleave across variants')
    r.add_argument('--interval', type=float, default=0.2)
    r.add_argument('--lock', default=os.environ.get('JE12_GATE_LOCK') or str(Path.home() / '.local/share/je12/gate.lock'),
                   help="flock file held for each run, or 'none'")
    r.add_argument('--max-load', type=float, default=0.25 * cores(), help='load1 at the start that flags a run')
    r.add_argument('--max-foreign', type=float, default=0.2 * cores(),
                   help='cores used by other processes (before, or on average during the run) that flag a run as loaded')
    r.add_argument('--wait-quiet', type=float, default=0, help='seconds to wait for a quiet machine before each run')
    r.add_argument('--node-dir', default=os.environ.get('JE12_NODE_DIR'))
    r.add_argument('--env', action='append', help='KEY=VALUE for the command')
    r.add_argument('--series', default='browser', help="keep per-process CPU series ('browser' = worker processes only)")
    r.add_argument('--top', type=int, default=30)
    r.add_argument('--pause', type=float, default=0, help='seconds between runs')
    r.add_argument('command', nargs='*')
    rp = sub.add_parser('report')
    rp.add_argument('dirs', nargs='+')
    rp.add_argument('--top', type=int, default=30)
    rp.add_argument('--md', type=Path)
    rp.add_argument('--include-loaded', action='store_true')
    cp = sub.add_parser('compare')
    cp.add_argument('a', nargs='+')
    cp.add_argument('--vs', nargs='+', required=True)
    cp.add_argument('--include-loaded', action='store_true')
    args = ap.parse_args()
    if args.cmd == 'report':
        text = render(load_analyses(args.dirs), top=args.top, include_loaded=args.include_loaded)
        if args.md:
            args.md.write_text(text)
        print(text)
        return 0
    if args.cmd == 'compare':
        print(compare(args.a, args.vs, args.include_loaded))
        return 0
    set_subreaper()
    cmd = args.command or ['bash', 'scripts/restructure-gates.sh', 'all']
    variants = [v.split('=', 1) for v in args.variant] or [[args.label or 'run', str(ROOT)]]
    stamp = time.strftime('%Y%m%d-%H%M%S')
    rcs = []
    for i in range(args.runs):
        for name, d in variants:
            label = f'{name}#{i + 1}'
            out = args.out / f'{stamp}-{name}-{i + 1:02d}'
            a = one_run(cmd, Path(d), out, args, label)
            rcs.append(a['rc'])
            if args.pause:
                time.sleep(args.pause)
    for name, _ in variants:
        dirs = sorted(str(p) for p in args.out.glob(f'{stamp}-{name}-*'))
        (args.out / f'{stamp}-{name}-summary.md').write_text(render(load_analyses(dirs), top=args.top))
        print(f'gate-timing: summary {args.out / f"{stamp}-{name}-summary.md"}', file=sys.stderr)
    if len(variants) == 2:
        A = sorted(str(p) for p in args.out.glob(f'{stamp}-{variants[0][0]}-[0-9]*'))
        B = sorted(str(p) for p in args.out.glob(f'{stamp}-{variants[1][0]}-[0-9]*'))
        text = compare(A, B)
        (args.out / f'{stamp}-compare.txt').write_text(text + '\n')
        print(text)
    return 0 if all(rc == 0 for rc in rcs) else 1


if __name__ == '__main__':
    sys.exit(main())

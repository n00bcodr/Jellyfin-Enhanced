"""Partition accounting shared by execution and coverage validation."""
from collections import Counter
import re
from pathlib import Path
import xml.etree.ElementTree as ET


def validate_manifest(manifest, allow_single=False):
    cases = manifest['cases']
    shards = manifest['shards']
    if not cases or len(shards) < (1 if allow_single else 2) or len(shards) > 4:
        raise ValueError('Expected nonempty discovery and 2–4 partitions')
    ids = [case['id'] for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate discovered case identity')
    assigned = [case for shard in shards for case in shard['cases']]
    if Counter(assigned) != Counter(ids):
        raise ValueError('Missing or duplicate case partition')
    if any(not re.fullmatch(r'shard-[0-3]', s['id']) for s in shards):
        raise ValueError('Invalid partition directory identity')
    if len({s['id'] for s in shards}) != len(shards) or any(not s['cases'] for s in shards):
        raise ValueError('Empty or duplicate partition')
    owners = {}
    by_id = {case['id']: case for case in cases}
    for shard in shards:
        expected_methods = {by_id[i]['method'] for i in shard['cases']}
        if set(shard.get('methods', [])) != expected_methods or len(shard['methods']) != len(expected_methods):
            raise ValueError('Partition method filter does not match its cases')
        for case_id in shard['cases']:
            case = by_id[case_id]
            # A VSTest method filter cannot split a theory. Disabled collections
            # must also stay whole, preserving process-global fixture semantics.
            for unit in [('method', case['method'])] + ([('serial', case['collection'])] if case.get('serial') else []):
                if unit in owners and owners[unit] != shard['id']:
                    raise ValueError('A method or serial collection spans partitions')
                owners[unit] = shard['id']
    return manifest


def partition(cases, count, durations=None):
    if count not in (2, 3, 4):
        raise ValueError('Backend concurrency must be 2–4')
    # Disabled collections run after parallel collections in each process. A
    # sum of case durations alone gives that process unrelated parallel work
    # while another process still has free collection slots. Model the critical
    # path using the same 8 // count threads as the actual xUnit workers.
    measured = bool(durations)
    durations = durations or {}
    groups = {}
    for case in cases:
        unit = ('serial', case['collection']) if case.get('serial') else ('class', case['method'].rsplit('.', 1)[0])
        groups.setdefault(unit, []).append(case)
    shards = [dict(id=f'shard-{i}', cases=[], methods=[], estimated_seconds=0.0) for i in range(count)]
    schedules = {s['id']: dict(serial=0.0, parallel={}) for s in shards}
    threads = 8 // count
    def weight(group):
        return sum(durations.get(case['name'], 1.0) for case in group)
    def wall(schedule, unit=None, group=None, seconds=0.0):
        serial = schedule['serial']
        parallel = dict(schedule['parallel'])
        if unit is not None:
            if unit[0] == 'serial': serial += seconds
            else:
                collection = group[0]['collection']
                parallel[collection] = parallel.get(collection, 0.0) + seconds
        slots = [0.0] * threads
        for duration in sorted(parallel.values(), reverse=True):
            slot = min(range(threads), key=lambda i: (slots[i], i))
            slots[slot] += duration
        return serial + max(slots)
    for unit, group in sorted(groups.items(), key=lambda entry: (-weight(entry[1]), entry[0])):
        seconds = weight(group)
        def cost(shard):
            estimate = wall(schedules[shard['id']], unit, group, seconds) if measured else shard['estimated_seconds']
            return estimate, len(shard['cases']), shard['id']
        shard = min(shards, key=cost)
        shard['cases'].extend(c['id'] for c in group)
        shard['methods'].extend(sorted({c['method'] for c in group}))
        shard['estimated_seconds'] += seconds
        schedule = schedules[shard['id']]
        if unit[0] == 'serial': schedule['serial'] += seconds
        else:
            collection = group[0]['collection']
            schedule['parallel'][collection] = schedule['parallel'].get(collection, 0.0) + seconds
        if measured: shard['estimated_wall_seconds'] = wall(schedule)
    return validate_manifest(dict(version=1, cases=cases, shards=shards))

def trx_cases(path):
    root = ET.parse(path).getroot()
    return [dict(name=r.attrib['testName'], outcome=r.attrib['outcome'],
                 duration=r.attrib.get('duration', '00:00:00'))
            for r in root.findall('.//{*}UnitTestResult')]


def validate_results(manifest, directory, allow_failures=False):
    validate_manifest(manifest, allow_single=True)
    run_id = manifest.get('run_id', '')
    if not re.fullmatch('[0-9a-f]{32}', run_id):
        raise ValueError('Missing execution run ID')
    by_id = {c['id']: c for c in manifest['cases']}
    for shard in manifest['shards']:
        if shard.get('run_id') != run_id:
            raise ValueError('Execution run ID mismatch across partitions')
        if 'exit_code' not in shard or (shard['exit_code'] != 0 and not allow_failures):
            raise ValueError(f"Shard {shard['id']} failed or never completed")
        reports = list((Path(directory) / shard['id']).glob('*.trx'))
        if len(reports) != 1:
            raise ValueError('Expected one fresh TRX per partition')
        actual = trx_cases(reports[0])
        expected = Counter(by_id[i]['name'] for i in shard['cases'])
        if not actual or Counter(c['name'] for c in actual) != expected:
            raise ValueError(f"Missing/duplicate/unexpected executed cases in {shard['id']}")
        if not allow_failures and any(c['outcome'] not in ('Passed', 'NotExecuted') for c in actual):
            raise ValueError(f"Non-successful case in {shard['id']}")

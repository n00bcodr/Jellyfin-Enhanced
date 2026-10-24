#!/usr/bin/env python3
"""Build afresh on every invocation, then run isolated complete backend partitions."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from uuid import uuid4

from partitions import partition, trx_cases, validate_manifest, validate_results

ROOT = Path(__file__).resolve().parents[2]
WITNESS = 'JE.Tests.IntegrationAcquisitionStampFeedTests.LifetimeExtensionReactivatesAStoredExpiredFactExactlyOnce'


def run(command, log, env=None):
    started = time.monotonic()
    print('Running: ' + ' '.join(map(str, command)), flush=True)
    with Path(log).open('w') as output:
        code = subprocess.run(list(map(str, command)), cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT).returncode
    print(Path(log).read_text(), end='', flush=True)
    return dict(exit_code=code, seconds=time.monotonic() - started)


def prepare_build(target, directory):
    properties = ['-c', 'Release', '-p:JellyfinTarget=' + target, '-p:RestoreLockedMode=true', '-m:4']
    # No persisted identity or reuse decision: every invocation builds afresh.
    (directory.parent / 'build-identity.json').unlink(missing_ok=True)
    shutil.rmtree(directory, ignore_errors=True)
    result = run(['dotnet', 'build', 'tests/backend/JE.Tests.csproj', *properties,
                  '--artifacts-path', directory], directory.parent / 'build.log')
    if result['exit_code']:
        raise RuntimeError('Backend build failed')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['jf10', 'jf12'], required=True)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--shards', type=int, choices=[1, 2, 3, 4], default=2)
    parser.add_argument('--preflight-witnesses', action='store_true')
    parser.add_argument('--durations', type=Path, help='Previous full TRX used only for partition weights')
    args = parser.parse_args()
    results = args.results.resolve()
    args.build = args.build.resolve()
    expected_build = results.parent.parent / 'build' / args.target / 'snapshot'
    if results.name != args.target or results.parent.name != 'backend' or args.build != expected_build:
        parser.error('Outputs must be backend/<target> and build/<target>/snapshot under one artifacts root')
    args.build.parent.mkdir(parents=True, exist_ok=True)
    # The lock covers all readers/copying too: no collector ever touches this
    # immutable build, and another invocation cannot replace it mid-copy.
    with (args.build.parent / 'build.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            weights = {}
            if args.durations:
                for case in trx_cases(args.durations):
                    h, m, s = map(float, case['duration'].split(':'))
                    weights[case['name']] = h * 3600 + m * 60 + s
            shutil.rmtree(results, ignore_errors=True)
            results.mkdir(parents=True)
            receipt = prepare_build(args.target, args.build)
            (results / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            assemblies = list((args.build / 'bin/JE.Tests').rglob('JE.Tests.dll'))
            if len(assemblies) != 1: raise ValueError('Expected one built backend test assembly')
            discovery = results / 'discovery.json'
            if run(['dotnet', assemblies[0], '--suite-manifest', discovery], results / 'discovery.log')['exit_code']:
                raise RuntimeError('Backend discovery failed')
            cases = json.loads(discovery.read_text())
            if not cases: raise ValueError('Empty backend discovery')
            if args.shards == 1:
                shards = [dict(id='shard-0', cases=[c['id'] for c in cases], methods=sorted({c['method'] for c in cases}))]
                manifest = dict(version=1, cases=cases, shards=shards)
            else:
                manifest = partition(cases, args.shards, weights)
                shards = manifest['shards']
            manifest['run_id'] = uuid4().hex
            manifest['build'] = receipt
            manifest_path = results / 'partitions.json'
            manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
            def worker(shard, witness=False):
                destination = results / ('witness' if witness else shard['id'])
                destination.mkdir()
                build = destination / 'build'
                shutil.copytree(args.build, build)
                for assembly in (build / 'bin/JE.Tests').rglob('JE.Tests.dll'):
                    (assembly.parent / 'xunit.runner.json').write_text(json.dumps({'maxParallelThreads': 8 // args.shards}))
                temporary = destination / 'tmp'
                temporary.mkdir()
                env = {**os.environ, 'TMPDIR': str(temporary), 'TEMP': str(temporary), 'TMP': str(temporary)}
                settings = ET.Element('RunSettings')
                configuration = ET.SubElement(settings, 'RunConfiguration')
                ET.SubElement(configuration, 'TestCaseFilter').text = ('FullyQualifiedName=' + WITNESS if witness else
                    '|'.join('FullyQualifiedName=' + m for m in shard['methods']))
                settings_path = destination / 'partition.runsettings'
                ET.ElementTree(settings).write(settings_path, encoding='unicode')
                command = ['dotnet', 'test', 'tests/backend/JE.Tests.csproj', '-c', 'Release', '-p:JellyfinTarget=' + args.target,
                           '-m:4', '--artifacts-path', build, '--no-build', '--no-restore', '--results-directory', destination,
                           '--logger', 'trx;LogFileName=cases.trx', '--settings', settings_path]
                if not witness:
                    command += ['--collect:XPlat Code Coverage', '--', 'DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=cobertura,json']
                result = run(command, destination / 'execution.log', env)
                shard.update(result, run_id=manifest['run_id'])
                # Release each disposable worker copy after collection.
                shutil.rmtree(build)
                return result['exit_code']
            if args.preflight_witnesses:
                if WITNESS not in {c['method'] for c in cases}:
                    raise ValueError('Known-failure witness is missing from discovery')
                witness = {}
                witness_code = worker(witness, witness=True)
                actual_witness = trx_cases(results / 'witness/cases.trx')
                if len(actual_witness) != 1 or actual_witness[0]['name'] != WITNESS:
                    raise ValueError('Witness preflight did not execute exactly the expected test')
                if witness_code:
                    (results / 'status.json').write_text(json.dumps(dict(status='incomplete', reason='Known-failing witness failed', witness=witness)) + '\n')
                    print('INCOMPLETE: known-failing StampFeed witness failed; full suite was not executed', flush=True)
                    return 1
            with ThreadPoolExecutor(max_workers=args.shards) as pool:
                codes = list(pool.map(worker, shards))
            manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
            validate_results(manifest, results, allow_failures=True)
            if any(codes):
                (results / 'status.json').write_text(json.dumps(dict(status='failed', reason='All cases accounted for; one or more backend tests failed')) + '\n')
                return 1
            return 0
        except (OSError, ValueError, RuntimeError, ET.ParseError, subprocess.CalledProcessError) as error:
            results.mkdir(parents=True, exist_ok=True)
            (results / 'status.json').write_text(json.dumps(dict(status='incomplete', reason=str(error))) + '\n')
            print('INCOMPLETE: ' + str(error), file=sys.stderr)
            return 1


if __name__ == '__main__':
    raise SystemExit(main())

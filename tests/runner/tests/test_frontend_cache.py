"""Instrumentation text may be shared; browser state and counters may not."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class InstrumentationTests(unittest.TestCase):
    def test_immutable_text_and_independent_counters(self):
        result = subprocess.run(['node', 'tests/runner/fixtures/instrumentation-cache.mjs'],
                                cwd=ROOT, env={**os.environ, 'JE_INSTRUMENT_CACHE': '1'},
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(0, result.returncode, result.stderr)


class DiskInstrumentationTests(unittest.TestCase):
    def test_independent_processes_share_only_verified_immutable_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            module = (ROOT / 'tests/frontend/helpers/instrumentation.mjs').as_uri()
            code = f'''import assert from 'node:assert/strict';
import {{ instrumentSource }} from {json.dumps(module)};
import {{ createInstrumenter }} from 'istanbul-lib-instrument';
for (const [source, file, options] of [['globalThis.x=1;', '/x.js', {{}}],
 ['globalThis.x=2;', '/x.js', {{}}], ['globalThis.x=1;', '/other.js', {{}}],
 ['globalThis.x=1;', '/x.js', {{compact:false}}]]) {{
 assert.equal(instrumentSource(source,file,options), createInstrumenter(options).instrumentSync(source,file));
}}'''
            env = {**os.environ, 'JE_INSTRUMENT_CACHE_DIR': tmp, 'JE_INSTRUMENT_CACHE': '1'}
            for _ in range(2):
                result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=ROOT, env=env,
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(0, result.returncode, result.stderr)
            entries = list(Path(tmp).glob('*.json'))
            self.assertEqual(4, len(entries))
            entry = entries[0]
            record = json.loads(entry.read_text())
            record['source'] = 'throw new Error("corrupt cache");'
            entry.write_text(json.dumps(record))
            result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(0, result.returncode, result.stderr)

// Loaded (`--import`) into every test file's process by tests/frontend/run.mjs when JE_EARLY_FAILURES names a file:
// each failing test is appended to that file the moment it fails, as `✖ <file> :: <test path>`. `node --test` reports
// a file's results only once every file before it in its list has been reported, so without this a failure in a file
// late in the list shows only near the end of the run. Reporting only: it never changes a result or adds a test.
import { afterEach } from 'node:test';
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';

const log = process.env.JE_EARLY_FAILURES;
if (log && process.env.NODE_TEST_CONTEXT === 'child-v8') {       // a test file's own process, not the runner
    afterEach(t => {
        if (t.passed !== false) return;
        try { appendFileSync(log, `✖ ${relative(process.cwd(), t.filePath ?? '')} :: ${t.fullName}\n`); } catch { /* reporting only */ }
    });
}

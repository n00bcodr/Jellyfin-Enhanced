// node:test reporter for the restructure failure ratchet (scripts/restructure-gates.sh, PLAN.md "Gates").
// Writes one line per test (suites excluded): `PASS|FAIL|SKIP <file relative to cwd> :: <ancestors > name>`.
// Events are keyed by file, because node guarantees declaration order only within one file.
import { relative } from 'node:path';

export default async function* ratchetReporter(source) {
  const stacks = new Map();
  const id = data => {
    const file = data.file ? relative(process.cwd(), data.file) : '<unknown>';
    const stack = stacks.get(file) ?? [];
    return `${file} :: ${[...stack.slice(0, data.nesting), data.name].join(' > ')}`;
  };
  for await (const { type, data } of source) {
    if (type === 'test:start') {
      const file = data.file ? relative(process.cwd(), data.file) : '<unknown>';
      const stack = stacks.get(file) ?? [];
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
      stacks.set(file, stack);
    } else if ((type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') {
      const status = data.skip || data.todo ? 'SKIP' : type === 'test:fail' ? 'FAIL' : 'PASS';
      yield `${status} ${id(data)}\n`;
    }
  }
}

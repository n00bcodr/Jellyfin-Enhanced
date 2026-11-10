// frontend.md §5.1: every client/src .ts file ≤ 800 lines (`*-styles.ts` / `*.css` ≤ 1500; files with a
// generated header are exempt). Today's offenders are frozen in size-baseline.json and may only shrink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCounts, MAX_LINES, MAX_STYLE_LINES, readJson, sizeOffenders, withoutComments } from './scan.mjs';

const asCounts = map => Object.fromEntries(Object.entries(map).map(([file, lines]) => [file, { lines }]));

test(`no client/src file grows past ${MAX_LINES} lines (${MAX_STYLE_LINES} for styles) (ratchet)`, t => {
  const { regressions, improvements } = compareCounts(asCounts(sizeOffenders()), asCounts(withoutComments(readJson('size-baseline.json'))));
  for (const line of improvements) t.diagnostic(`shrank, lower or remove its size-baseline.json entry: ${line}`);
  assert.deepEqual(regressions, [], `files over the line limit or grown past their baseline (split them; never raise the baseline)\n  ${regressions.join('\n  ')}`);
});

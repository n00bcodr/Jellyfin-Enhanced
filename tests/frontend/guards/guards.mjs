// The bug-class guards: name (test file and `<name>-baseline.json`), rules, and scanner.
import { scanConfigControls } from './config-control.mjs';
import { scanCss } from './css.mjs';
import { scanErrorEmpty } from './error-empty.mjs';
import { scanEscape } from './escape.mjs';
import { scanLeaks } from './leaks.mjs';
import { scanPerformance } from './perf.mjs';

export const GUARDS = [
  { name: 'escape-guard', rules: ['X1'], scan: scanEscape },
  { name: 'css-injection-guard', rules: ['X2'], scan: scanCss },
  { name: 'error-as-empty-guard', rules: ['R9-fail-empty', 'R9-fail-cached', 'R9-fail-renders-empty'], scan: scanErrorEmpty },
  { name: 'leak-guard', rules: ['L1-unbounded-cache', 'L2-global-listener', 'L3-observer', 'L4-interval', 'L5-retry-uncapped', 'L6-object-url'], scan: scanLeaks },
  { name: 'performance-rules-guard', rules: ['R3-body-observer', 'R5-interval-dom', 'R6-remote-asset'], scan: scanPerformance },
  { name: 'config-control-guard', rules: ['C1-no-control'], scan: scanConfigControls },
];

export const guard = name => {
  const found = GUARDS.find(g => g.name === name);
  if (!found) throw new Error(`unknown guard ${name}`);
  return found;
};

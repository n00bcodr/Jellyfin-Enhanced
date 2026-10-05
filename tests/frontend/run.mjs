import { spawnSync } from 'node:child_process';
import { discoverTests, repositoryRoot } from './helpers/discovery.mjs';

const result = spawnSync(process.execPath,
  ['--test', ...process.argv.slice(2), ...discoverTests()],
  { cwd: repositoryRoot, stdio: 'inherit' });
process.exitCode = result.error || result.signal || result.status === null ? 1 : result.status;

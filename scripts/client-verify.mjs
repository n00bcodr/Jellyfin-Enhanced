import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './client-build.mjs';

/** A single gate, serialized with other heavy validation on the execution host. */
function run(command, args, env) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit', env });
  if (result.error) console.error(`Cannot run ${command}: ${result.error.message}`);
  if (result.error || result.signal || result.status !== 0) process.exit(result.status || 1);
}

const env = { ...process.env, DOTNET_PROCESSOR_COUNT: '2' };
if (process.argv.length === 2) {
  const lock = env.JE_VALIDATION_LOCK || resolve(repositoryRoot, '..', 'je-v12-validation.lock');
  console.log(`Serializing rewrite validation with flock ${lock}`);
  run('flock', [lock, process.execPath, fileURLToPath(import.meta.url), '--locked'], env);
} else if (process.argv.length === 3 && process.argv[2] === '--locked') {
  run('npm', ['run', 'contracts:check'], env);
  run('npm', ['run', 'client:check'], env);
  run('npm', ['run', 'inventory:rewrite:check'], env);
  run('npm', ['run', 'test:client-build'], env);
  run('npm', ['run', 'test:contract-boundary'], env);
  run('npm', ['run', 'test:frontend'], env);
  run('python3', ['tests/run.py', 'backend', '--target', 'jf12'], env);
} else {
  console.error('Usage: npm run verify:rewrite');
  process.exitCode = 1;
}

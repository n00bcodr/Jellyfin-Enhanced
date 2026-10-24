/** Reconstruct an Istanbul map from retained raw data without executing tests. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInstrumenter } from 'istanbul-lib-instrument';
import coverage from 'istanbul-lib-coverage';

const [root, output, ...rawDirectories] = process.argv.slice(2);
if (!root || !output || !rawDirectories.length) throw new Error('Expected repository, output, raw directories');
const map = coverage.createCoverageMap({});
function inventory(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) inventory(file);
    else if (file.endsWith('.js')) {
      const instrumenter = createInstrumenter();
      instrumenter.instrumentSync(readFileSync(file, 'utf8'), file);
      map.addFileCoverage(instrumenter.lastFileCoverage());
    }
  }
}
inventory(resolve(root, 'Jellyfin.Plugin.JellyfinEnhanced/js'));
for (const directory of rawDirectories) {
  for (const file of readdirSync(directory)) map.merge(JSON.parse(readFileSync(join(directory, file), 'utf8')));
}
writeFileSync(output, JSON.stringify(map));
console.log(JSON.stringify(map.getCoverageSummary()));

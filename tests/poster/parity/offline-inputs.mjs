// Credential-free inputs. The profiles generator supplies the exhaustive synthetic metadata.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const inputs = join(dirname(fileURLToPath(import.meta.url)), 'data', 'inputs');
// Start empty: later steps read every tagcache-* file here, so a stale live capture would leak in.
rmSync(inputs, { recursive: true, force: true });
mkdirSync(inputs, { recursive: true });
const write = (name, value) => writeFileSync(join(inputs, name), JSON.stringify(value, null, 2));
const id = '00000000000000000000000000000001';
write('users.json', [{ id, name: 'synthetic-admin', isAdmin: true, audioPreference: null }]);
for (const kind of ['settings-raw', 'settings-web', 'tagcache', 'userdata', 'reviews']) write(`${kind}-${id}.json`, {});
write('public-config.json', {});
writeFileSync(join(inputs, 'plugin-config.xml'), '<?xml version="1.0" encoding="utf-8"?><PluginConfiguration />');
console.log('Prepared disposable synthetic parity inputs; no Jellyfin server or credentials required.');

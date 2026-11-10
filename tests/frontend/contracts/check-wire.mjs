// Cross-language test bridge: read a real C# response on stdin and run the shipped validator.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/contracts/bootstrap.js', import.meta.url), 'utf8'), context);
const value = JSON.parse(readFileSync(0, 'utf8'));
if (process.argv[2] === 'bookmarks') context.window.__JE_BOOTSTRAP_CONTRACT__.parseBookmarkDocument(value);
else if (process.argv[2] === 'settings') context.window.__JE_BOOTSTRAP_CONTRACT__.parseSettingsDocument(value, process.argv[3] === 'true');
else context.window.__JE_BOOTSTRAP_CONTRACT__.parseBootstrap(value, process.argv[2], process.argv[3] === 'true');

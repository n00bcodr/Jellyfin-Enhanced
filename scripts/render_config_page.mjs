// Prints the admin config page as the browser builds it: configPage.html with every <div data-je-section="..."> replaced by
// the fieldset jeAdmin.js renders from Configuration/admin/*.js. scripts/generate_config_flag_groups.py reads this instead of the
// raw file, because most settings now live in the schema rather than in the HTML.
//
//   node scripts/render_config_page.mjs > rendered.html
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const config = join(dirname(fileURLToPath(import.meta.url)), '..', 'Jellyfin.Plugin.JellyfinEnhanced', 'Configuration');
const dom = new JSDOM(readFileSync(join(config, 'configPage.html'), 'utf8'), { runScripts: 'outside-only' });

dom.window.eval(readFileSync(join(config, 'jeAdmin.js'), 'utf8'));
for (const name of readdirSync(join(config, 'admin')).filter((f) => f.endsWith('.js')).sort()) {
    dom.window.eval(readFileSync(join(config, 'admin', name), 'utf8'));
}
// shell: false renders the sections only; the sidebar and event wiring need a live page.
dom.window.JEAdmin.mount(dom.window.document, { shell: false });
// Linked copies (the Services tab) repeat cards that exist elsewhere; leaving them in would double-count every setting.
dom.window.document.querySelectorAll('.jea-mirror').forEach((el) => el.remove());
process.stdout.write(dom.serialize());

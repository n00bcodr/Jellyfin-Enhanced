#!/usr/bin/env node
// Fetches real inputs for the native poster tag parity harness from a JE test
// server. Read-only: it only issues GET requests (plus sign-ins) and reads the
// server's config directory from the host when one is given.
//
//   node fetch-inputs.mjs --server URL --admin NAME:PASSWORD --config-dir HOST_PATH_OF_/config
//                         [--user NAME:PASSWORD ...] [--out DIR]
//
// Writes, per user: the spoiler-stripped tag cache (GET tag-cache/{id}), the
// user's item UserData, the viewer-visible review averages (GET
// reviews/ratings), the raw settings.json (from --config-dir) and the web's
// view of it (GET user-settings/{id}/settings.json, only when the file exists,
// so the endpoint never writes defaults). Plus public-config and the plugin XML.
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
};
const options = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const required = (name) => {
    const value = option(name);
    if (!value) {
        console.error('usage: node fetch-inputs.mjs --server URL --admin NAME:PASSWORD --config-dir HOST_PATH_OF_/config [--user NAME:PASSWORD ...] [--out DIR]');
        process.exit(2);
    }
    return value;
};
const server = required('--server').replace(/\/$/, '');
const [adminName, ...adminRest] = required('--admin').split(':');
const adminPassword = adminRest.join(':');
const userLogins = options('--user').map((pair) => {
    const [name, ...rest] = pair.split(':');
    return [name, rest.join(':')];
});
const configDir = required('--config-dir');
const out = option('--out', join(here, 'data', 'inputs'));
mkdirSync(out, { recursive: true });

const clientHeader = 'MediaBrowser Client="je-poster-tags-parity", Device="harness", DeviceId="je-poster-tags-parity", Version="1.0"';

async function signIn(name, password) {
    const res = await fetch(`${server}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: clientHeader },
        body: JSON.stringify({ Username: name, Pw: password }),
    });
    if (!res.ok) throw new Error(`sign-in ${name}: HTTP ${res.status}`);
    const body = await res.json();
    return { token: body.AccessToken, user: body.User };
}

async function get(token, path) {
    const res = await fetch(`${server}${path}`, { headers: { Authorization: `${clientHeader}, Token="${token}"` } });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
}

const write = (file, value) => writeFileSync(join(out, file), JSON.stringify(value));
const pluginDir = join(configDir, 'plugins', 'configurations');

const admin = await signIn(adminName, adminPassword);
const tokens = new Map([[admin.user.Id, admin.token]]);
for (const [name, password] of userLogins) {
    try {
        const session = await signIn(name, password);
        tokens.set(session.user.Id, session.token);
    } catch (e) {
        console.warn(`Could not sign in ${name}: ${e.message}`);
    }
}

write('public-config.json', await get(admin.token, '/JellyfinEnhanced/public-config'));
const xmlPath = join(pluginDir, 'Jellyfin.Plugin.JellyfinEnhanced.xml');
if (!existsSync(xmlPath)) throw new Error(`Plugin configuration not found at ${xmlPath} (pass --config-dir)`);
copyFileSync(xmlPath, join(out, 'plugin-config.xml'));

const allUsers = await get(admin.token, '/Users');
const users = [];
for (const user of allUsers) {
    const id = user.Id;
    const settingsPath = join(pluginDir, 'Jellyfin.Plugin.JellyfinEnhanced', id, 'settings.json');
    if (!existsSync(settingsPath)) continue; // never let GET settings.json write defaults
    const token = tokens.get(id);

    const cache = await get(admin.token, `/JellyfinEnhanced/tag-cache/${id}`);
    write(`tagcache-${id}.json`, cache.items || {});

    const items = await get(admin.token, `/Items?userId=${id}&Recursive=true&IncludeItemTypes=Movie,Series,Season,Episode,BoxSet,Video&EnableImages=false&EnableUserData=true&Fields=`);
    const userData = {};
    for (const item of items.Items || []) {
        const ud = item.UserData || {};
        userData[item.Id.replace(/-/g, '').toLowerCase()] = { Played: !!ud.Played, UnplayedItemCount: ud.UnplayedItemCount ?? null, PlayedPercentage: ud.PlayedPercentage ?? null };
    }
    write(`userdata-${id}.json`, userData);

    // Viewer-filtered review averages: needs the viewer's own session; others use the admin's view.
    const keys = new Set();
    for (const entry of Object.values(cache.items || {})) {
        if ((entry.Type === 'Movie' || entry.Type === 'Series') && /^\d+$/.test(entry.TmdbId || '')) {
            keys.add(`${entry.Type === 'Movie' ? 'movie' : 'tv'}:${entry.TmdbId}`);
        }
    }
    const reviews = {};
    const keyList = [...keys];
    for (let i = 0; i < keyList.length; i += 200) {
        const batch = keyList.slice(i, i + 200);
        const data = await get(token || admin.token, `/JellyfinEnhanced/reviews/ratings?keys=${encodeURIComponent(batch.join(','))}`);
        Object.assign(reviews, data.ratings || {});
    }
    write(`reviews-${id}.json`, reviews);

    write(`settings-raw-${id}.json`, JSON.parse(readFileSync(settingsPath, 'utf8')));
    write(`settings-web-${id}.json`, await get(admin.token, `/JellyfinEnhanced/user-settings/${id}/settings.json`));

    users.push({
        id,
        name: user.Name,
        audioPreference: user.Configuration?.AudioLanguagePreference ?? null,
        isAdmin: !!user.Policy?.IsAdministrator,
        reviewsViewer: token ? 'self' : 'admin',
    });
    console.log(`${user.Name}: ${Object.keys(cache.items || {}).length} entries, ${keyList.length} review keys${token ? '' : ' (admin view)'}`);
}

write('users.json', users);
console.log(`Inputs written to ${out}`);

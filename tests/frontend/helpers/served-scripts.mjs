// Scripts as the server serves them. The translations script carries the display-language policy, which the server writes
// in when it serves the file (Helpers/LanguageTags.cs TranslationsScript): the rule from js/language-policy.json and the
// locale bundles the build embeds (js/locales). ApiShippedLocalesTests checks the server's side, including a build with an
// added locale file run in node; this does the same from the files here, so tests run the script the browser gets.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositoryRoot, speedProfile } from './discovery.mjs';

const jsRoot = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/js');

const MARKER = /^(\s*)const LANGUAGE_POLICY = null; \/\/ je:language-policy$/m;

/** The locale codes in js/locales (or another folder), ordered as the server orders them. */
export function shippedLocales(folder = resolve(jsRoot, 'locales')) {
  return readdirSync(folder).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    .sort((a, b) => { const x = a.toUpperCase(), y = b.toUpperCase(); return x < y ? -1 : x > y ? 1 : 0; });
}

/** The translations script with the policy written in, as served; other scripts as they are. */
export function served(path, source, { locales } = {}) {
  if (!speedProfile && locales === undefined) locales = shippedLocales();
  if (path !== 'enhanced/translations.js') return source;
  const rule = JSON.parse(readFileSync(resolve(jsRoot, 'language-policy.json'), 'utf8'));
  const policy = { space: rule.space, reserved: rule.reserved, tag: rule.tag, shipped: speedProfile ? (locales ?? shippedLocales()) : locales };
  return source.replace(MARKER, (_, indent) => `${indent}const LANGUAGE_POLICY = ${JSON.stringify(policy)};`);
}

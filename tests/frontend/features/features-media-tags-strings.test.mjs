import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { jsRoot } from '../helpers/harness.mjs';

// The Media Tags surfaces users see (the hub, its editors and the item editor) show no hard-coded English: every
// word comes from the locale files through JE.t. Codec and brand samples, icon ligatures and code are not words a
// user reads in their language. The administrator's configuration page (enhanced/admintags) is plain English like
// the rest of that page, so it is not checked here.
const files = [
  ...readdirSync(`${jsRoot}/enhanced/settingspanel`).filter(f => /^ui-panel-(tag-|media-tags)/.test(f)).map(f => `enhanced/settingspanel/${f}`),
  'tags/tag-item-editor.js',
];
// Where a literal reaches the page: text, tooltips, labels, placeholders, the editors' el(tag, class, text)
// and table values such as { title: 'Quality' }.
const SINKS = [
  /\.(?:textContent|innerText|title|placeholder|alt)\s*=\s*(['"`])((?:\\.|(?!\1).)*?)\1/g,
  /setAttribute\(\s*'(?:aria-label|title|placeholder|aria-description|alt)'\s*,\s*(['"`])((?:\\.|(?!\1).)*?)\1/g,
  /\bel\(\s*'[a-z0-9]+'\s*,\s*[^,()]+,\s*(['"`])((?:\\.|(?!\1).)*?)\1/g,
  /createTextNode\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g,
  /\b(?:title|label|text|hint|note|description|placeholder)\s*:\s*(['"`])([A-Z][a-z]+(?: [^'"`]*)?)\1/g,
  // A section's sample chip that names its group ([['status', 'Awards']]).
  /\[\s*'status'\s*,\s*(['"`])([A-Z][a-z][^'"`]*)\1\s*\]/g,
];
// Sample content, not interface text: fictional logo names and the English fallback of a flag's name.
const SAMPLES = new Set(['Streamflix', 'Northwind Broadcasting', 'Harbor Kids Network', 'NWB']);
const words = text => /[A-Za-z]{2,}/.test(text) && !SAMPLES.has(text.trim());

test('the Media Tags settings code holds no hard-coded interface text', () => {
  const found = [];
  for (const file of files) {
    readFileSync(`${jsRoot}/${file}`, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const sink of SINKS) {
        for (const m of line.matchAll(sink)) {
          const text = m[2].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ' ');
          // A nested template the pattern cannot pair is code, not text.
          if (words(text) && !text.includes('${')) found.push(`${file}:${i + 1} ${JSON.stringify(m[2]).slice(0, 80)}`);
        }
      }
      // Markup text in template literals (icon ligatures are lowercase words joined by underscores).
      for (const m of line.matchAll(/>([^<>{}$`'"]*[A-Za-z]{3,}[^<>{}$`'"]*)</g)) {
        if (/[A-Z]|[a-z] [a-z]/.test(m[1]) && !/[=&|?;]/.test(m[1]) && !/@(param|returns|type)/.test(line) && words(m[1])) found.push(`${file}:${i + 1} markup ${JSON.stringify(m[1].trim())}`);
      }
    });
  }
  assert.deepEqual(found, []);
});

test('counted strings get their count as a number, never filled in by hand', () => {
  const found = [];
  for (const file of files) {
    readFileSync(`${jsRoot}/${file}`, 'utf8').split('\n').forEach((line, i) => {
      // JE.t picks plural forms only for a numeric count; a hand-filled {count} skips them.
      if (/\.replace\(\s*['"]\{(count|n|days|items)\}['"]/.test(line) || /[{,]\s*(count|n|days|items)\s*:\s*String\(/.test(line)) found.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

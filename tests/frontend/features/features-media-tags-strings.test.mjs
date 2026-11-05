import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

// The Media Tags settings surfaces (admin page and its sections, the hub, its editors and the item editor) show
// no hard-coded English: every word comes from the locale files through JE.t. Codec and brand samples, icon
// ligatures and code are not words a user reads in their language.
const files = [
  ...readdirSync(`${jsRoot}/enhanced/admintags`).filter(f => f.endsWith('.js')).map(f => `enhanced/admintags/${f}`),
  ...readdirSync(`${jsRoot}/enhanced/admintags/sections`).filter(f => f.endsWith('.js')).map(f => `enhanced/admintags/sections/${f}`),
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

test('the Custom rules table speaks only the loaded language, accessible names included', t => {
  const h = createHarness({ JE: { t: (key, params) => `«${key}${params ? JSON.stringify(params) : ''}»` },
    apiClient: { getCurrentUserId: () => 'user', getUrl: path => path, ajax: async () => ({ Tags: [], Items: [] }) } });
  t.after(() => h.close());
  h.JE.adminTags = {};
  h.load('enhanced/admintags/custom-rules-editor.js');
  h.document.body.innerHTML = h.JE.adminTags.CUSTOM_HTML;
  const rules = h.JE.adminTags.createCustomTagRules(h.document.body);
  rules.load({ CustomTagRules: [] });
  const texts = () => {
    const out = [];
    const walker = h.document.createTreeWalker(h.document.body, h.window.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim()) out.push(node.textContent.trim());
    for (const el of h.document.querySelectorAll('[aria-label], [title], [placeholder]')) for (const name of ['aria-label', 'title', 'placeholder']) if (el.getAttribute(name)) out.push(el.getAttribute(name));
    return out;
  };
  assert.ok(texts().some(text => text.includes('custom_tags_rules_empty')), 'the empty state is drawn');
  h.document.querySelector('#customTagRuleAdd').click();
  // Icon names are the icons' own identifiers, shown as they are.
  const stray = texts().filter(text => !/^«.*»$/.test(text) && !/^[a-z]+( [a-z]+)*$/.test(text) && !/^(delete)$/.test(text));
  assert.deepEqual(stray, []);
  assert.ok(texts().some(text => text.includes('custom_tags_rules_count{"count":1,"max":20}')), 'the count is a number');
});

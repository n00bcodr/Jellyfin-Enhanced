import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

/** Python-Markdown's default toc slug, which the docs site uses for heading anchors. */
const slug = heading => heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '-');
const anchors = new Set(read('docs/enhanced/tags.md').split('\n').filter(line => /^#{1,6} /.test(line)).map(line => slug(line.replace(/^#+ /, ''))));

for (const [file, tabsSource] of [
  // The hub is TypeScript now: its tab list is read from the source, not the generated bundle.
  ['client/src/features/media-tags/settings/ui-panel-media-tags.ts', /function tabsFor\(\) \{([\s\S]*?)\n {4}\}/],
  ['client/src/features/media-tags/admin/admin-tags.ts', /const TABS: readonly TabDef\[\] = \[([\s\S]*?)\];/],
]) {
  test(`every Media Tags tab in ${file.split('/').pop()} links to an existing user-guide heading`, () => {
    const source = read(file);
    assert.match(source, /const DOCS_URL = 'https:\/\/n00bcodr\.github\.io\/Jellyfin-Enhanced\/enhanced\/tags\/';/);
    const map = Object.fromEntries([...source.match(/const DOCS_ANCHORS = \{([^}]*)\}/)[1].matchAll(/(\w+): '([^']+)'/g)].map(m => [m[1], m[2]]));
    const ids = [...source.match(tabsSource)[1].matchAll(/id: '(\w+)'/g)].map(m => m[1]);
    assert.ok(ids.length >= 6);
    for (const id of ids) {
      assert.ok(map[id], `tab ${id} has a docs anchor`);
      assert.ok(anchors.has(map[id]), `#${map[id]} is a heading in docs/enhanced/tags.md`);
    }
  });
}

test('the docs link copy exists in the English source strings', () => {
  const en = JSON.parse(read('Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json'));
  assert.equal(typeof en.media_tags_docs_link, 'string');
  assert.match(en.media_tags_docs_link_label, /\{name\}/);
});

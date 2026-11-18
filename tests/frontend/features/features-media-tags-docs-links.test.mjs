import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

/** Python-Markdown's default toc slug, which the docs site uses for heading anchors. */
const slug = heading => heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '-');
const headingsOf = page => new Set(read(`docs/enhanced/${page}.md`).split('\n').filter(line => /^#{1,6} /.test(line)).map(line => slug(line.replace(/^#+ /, ''))));
const anchors = headingsOf('tags');
// Sections that moved off the overview page keep their old enhanced/tags/#anchor link working through this map in extra.js.
const moved = JSON.parse(read('docs/javascripts/extra.js').match(/var MOVED = (\{[^;]*\});/)[1]);

for (const [file, tabsSource] of [
  ['Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/settingspanel/ui-panel-media-tags.js', /function tabsFor\(\) \{([\s\S]*?)\n {4}\}/],
  ['Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/admintags/admin-tags.js', /const TABS = \[([\s\S]*?)\];/],
]) {
  test(`every Media Tags tab in ${file.split('/').pop()} links to an existing user-guide heading`, () => {
    const source = read(file);
    assert.match(source, /const DOCS_URL = 'https:\/\/n00bcodr\.github\.io\/Jellyfin-Enhanced\/enhanced\/tags\/';/);
    const map = Object.fromEntries([...source.match(/const DOCS_ANCHORS = \{([^}]*)\}/)[1].matchAll(/(\w+): '([^']+)'/g)].map(m => [m[1], m[2]]));
    const ids = [...source.match(tabsSource)[1].matchAll(/id: '(\w+)'/g)].map(m => m[1]);
    assert.ok(ids.length >= 6);
    for (const id of ids) {
      assert.ok(map[id], `tab ${id} has a docs anchor`);
      if (anchors.has(map[id])) continue;
      const target = moved[map[id]];
      assert.ok(target, `#${map[id]} is a heading in docs/enhanced/tags.md or has a redirect in docs/javascripts/extra.js`);
      assert.ok(headingsOf(target[0]).has(target[1]), `#${target[1]} is a heading in docs/enhanced/${target[0]}.md, where #${map[id]} redirects`);
    }
  });
}

test('the docs link copy exists in the English source strings', () => {
  const en = JSON.parse(read('Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json'));
  assert.equal(typeof en.media_tags_docs_link, 'string');
  assert.match(en.media_tags_docs_link_label, /\{name\}/);
});

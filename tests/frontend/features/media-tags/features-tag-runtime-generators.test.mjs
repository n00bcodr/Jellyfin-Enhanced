import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The tag tables have one authoritative source each. Generators project them into typed modules, client-build alone
// emits the browser scripts, and the poster assets are derived from those typed tables.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';
const types = 'client/src/features/media-tags/types';
const read = path => readFileSync(resolve(root, path), 'utf8');

/** A throwaway tree holding only `paths`; generators resolve their root from their own location. */
function sandbox(t, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'je-tag-generators-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of paths) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(resolve(root, path), join(dir, path));
  }
  return {
    path: file => join(dir, file),
    read: file => readFileSync(join(dir, file), 'utf8'),
    write: (file, text) => writeFileSync(join(dir, file), text),
    run: (script, ...args) => spawnSync('python3', [join(dir, script), ...args], { encoding: 'utf8' })
  };
}

/** Evaluates one object or array literal from an emitted classic script. */
function emittedLiteral(file, name) {
  const source = read(`${plugin}/js/tags/${file}`);
  const start = source.search(new RegExp(`\\b(?:var|const) ${name} = [[{]`));
  assert.notEqual(start, -1, `${name} is declared in ${file}`);
  const from = source.indexOf('=', start) + 1;
  const end = source.indexOf(';\n', from);
  return vm.runInNewContext(`(${source.slice(from, end)})`);
}

const plain = value => JSON.parse(JSON.stringify(value));

const genre = {
  script: 'scripts/generate_genre_labels.py',
  source: `${plugin}/js/tags/genre-icons.json`,
  table: `${types}/genre/genre-table.ts`,
  emitted: `${plugin}/js/tags/genretags.js`
};
const ratios = {
  script: 'scripts/generate_technical_ratios.py',
  source: `${plugin}/Shared/MediaTags/PosterTags/Resolution/TechnicalQualityRules.cs`,
  table: `${types}/quality/quality-data.ts`,
  emitted: `${plugin}/js/tags/qualitytags.js`
};

for (const [name, generator, edit, projected] of [
  ['genre', genre,
    text => text.replace('"action": "sports_martial_arts"', '"boundary probe": "sports_martial_arts",\n      "action": "sports_martial_arts"'),
    'boundary probe'],
  ['aspect', ratios,
    text => text.replace(/\[\] Ratios =([\s\S]*?)\(([\d.d /]+),\s*([\d.]+),\s*"([^"]+)"\)/, (all, head, value, tolerance) => `[] Ratios =${head}(1.111d, ${tolerance}, "Probe")`),
    '[1.111,']
]) {
  test(`the ${name} generator projects its source into the typed table and leaves emitted scripts to client-build`, t => {
    const box = sandbox(t, Object.values(generator));
    const script = box.read(generator.emitted);
    assert.equal(box.run(generator.script, '--check').status, 0, 'the published table is current');

    const edited = edit(box.read(generator.source));
    assert.notEqual(edited, box.read(generator.source), 'the fixture edit applies');
    box.write(generator.source, edited);
    const stale = box.run(generator.script, '--check');
    assert.equal(stale.status, 1, 'an edited source makes the typed table stale');
    assert.match(stale.stderr, /stale/);

    const written = box.run(generator.script);
    assert.equal(written.status, 0, written.stderr);
    assert.ok(box.read(generator.table).includes(projected), 'the source edit reaches the typed table');
    assert.equal(box.read(generator.emitted), script, 'emitted output stays with client-build');
    assert.equal(box.run(generator.script, '--check').status, 0);

    const once = box.read(generator.table);
    assert.equal(box.run(generator.script).status, 0);
    assert.equal(box.read(generator.table), once, 'regenerating is deterministic');
  });

  test(`the ${name} generator refuses a typed table without its markers`, t => {
    const box = sandbox(t, Object.values(generator));
    box.write(generator.table, box.read(generator.table).replace(/\/\/ End generated[^\n]*\n/, ''));
    const result = box.run(generator.script, '--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing or duplicate/);
  });
}

test('the generators leave the published typed tables unchanged', t => {
  for (const generator of [genre, ratios]) {
    const box = sandbox(t, Object.values(generator));
    const before = box.read(generator.table);
    assert.equal(box.run(generator.script).status, 0);
    assert.equal(box.read(generator.table), before, generator.table);
  }
});

// Python reads and writes text in the machine's default encoding unless told otherwise (cp1252 and \r\n on Windows):
// the table names genres in many scripts, so the generator must say UTF-8 and \n itself.
test('the genre generator reads and writes UTF-8 with \\n line ends whatever the default encoding is', t => {
  const box = sandbox(t, Object.values(genre));
  const published = readFileSync(resolve(root, genre.table));
  assert.ok(published.some(byte => byte > 0x7f) && !published.includes(13), 'the table has non-ASCII names and no \\r');
  const env = { ...process.env, PYTHONUTF8: '0', PYTHONCOERCECLOCALE: '0', LC_ALL: 'C', LANG: 'C' };
  const written = spawnSync('python3', [box.path(genre.script)], { encoding: 'utf8', env });
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(readFileSync(box.path(genre.table)), published, 'the same bytes as with a UTF-8 default');
});

test('the emitted genre tables are exactly what genre-icons.json describes', () => {
  const table = JSON.parse(read(genre.source));
  const source = read(genre.emitted);
  const start = source.indexOf('var tables = ') + 'var tables = '.length;
  const emitted = plain(vm.runInNewContext(source.slice(start, source.indexOf('})();\n', start) + '})()'.length)));
  assert.deepEqual(emitted.genreIconMap, Object.assign({ default: table.defaultIcon }, ...Object.values(table.names)));
  assert.deepEqual(emitted.genreLabelOfIcon, Object.fromEntries(Object.keys(table.labels).map(label => [table.names.English[label], label])));
  assert.equal(emitted.genreOtherLabel, table.other.key);
});

test('the emitted aspect table is exactly what the server rules declare', () => {
  const source = read(ratios.source).split('[] Ratios =', 1 + 1)[1].split('};')[0];
  const declared = [...source.matchAll(/\(([\d.d /]+),\s*([\d.]+),\s*"([^"]+)"\)/g)].map(([, value, tolerance, label]) => {
    const [top, bottom = 1] = value.split('/').map(part => Number.parseFloat(part));
    return [top / bottom, Number(tolerance), label];
  });
  assert.ok(declared.length > 5);
  assert.deepEqual(plain(emittedLiteral('qualitytags.js', 'ratios')), declared);
});

// Each table is edited in a private copy, so a reader that falls back to an emitted script, or skips a table it can no
// longer find, fails here rather than quietly reproducing the committed assets.
const assetProbe = String.raw`
import importlib.util, json, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('poster_assets', sys.argv[1])
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
def edited(key, old, new, read):
    source = assets.TABLE_SOURCE[key]
    text = source.read_text(encoding='utf-8')
    if old not in text:
        sys.exit(f'{key}: probe anchor missing: {old}')
    with tempfile.TemporaryDirectory() as folder:
        copy = pathlib.Path(folder) / source.name
        copy.write_text(text.replace(old, new, 1), encoding='utf-8')
        assets.TABLE_SOURCE[key] = copy
        try:
            return read()
        finally:
            assets.TABLE_SOURCE[key] = source
print(json.dumps({
    'chinese': 'xq' in edited('media-language', "hant: 'tw'", "hant: 'xq'", assets.flag_codes)[0],
    'base': 'xw' in edited('media-language', "English: 'gb'", "English: 'xw'", assets.flag_codes)[0],
    'region': 'xz' in edited('media-language', "'ad ae af", "'xz ad ae af", assets.flag_codes)[0],
    'artwork': edited('media-language', 'viewBox="0 0 640 480"', 'viewBox="0 0 641 480"', assets.flag_codes)[1] != assets.flag_codes()[1],
    'quality': edited('qualitytags', "'4K': {", "'Probe': { bg: '#123456', text: '#654321' },\n    '4K': {", assets.quality_colours)['labels'].get('Probe'),
    'lowRes': edited('qualitytags', '[data-quality="LOW-RES"] {', '[data-quality="LOW-RES"] { background: #123456; color: #654321; } .probe {', assets.quality_colours)['labels']['LOW-RES'],
    'bases': 'Probe Base' in edited('qualitytags', "const audioBases = ['TRUEHD ATMOS',", "const audioBases = ['Probe Base', 'TRUEHD ATMOS',", assets.quality_colours)['compositeBases'],
    'ratingLogo': edited('rating-sources', '"imdb": "<svg', '"probe": "<svg', assets.rating_source_icons).get('rating-probe') is not None,
    'awardLogo': edited('award-tags', '"imdbTop250":"<svg', '"probe":"<svg', assets.award_icons).get('award-probe') is not None
}))
`;

test('every poster asset table comes from its typed module, including the ones a reader could silently skip', () => {
  const probes = JSON.parse(execFileSync('python3', ['-c', assetProbe, resolve(root, 'scripts/build_poster_assets.py')], { encoding: 'utf8' }));
  assert.deepEqual(probes, {
    chinese: true, base: true, region: true, artwork: true,
    quality: { background: '#123456', color: '#654321' },
    lowRes: { background: '#123456', color: '#654321' },
    bases: true, ratingLogo: true, awardLogo: true
  });
});

test('the committed poster assets match the typed tables and the check catches a stale copy', t => {
  execFileSync('python3', [resolve(root, 'scripts/build_poster_assets.py'), '--check'], { encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'je-poster-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'PosterTags');
  cpSync(resolve(root, `${plugin}/Assets/PosterTags`), out, { recursive: true });
  const colours = JSON.parse(readFileSync(join(out, 'quality-colours.json'), 'utf8'));
  colours.labels['4K'].background = '#000001';
  writeFileSync(join(out, 'quality-colours.json'), JSON.stringify(colours));
  const stale = spawnSync('python3', [resolve(root, 'scripts/build_poster_assets.py'), '--check', '--out', out], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /quality-colours\.json: stale/);
});

test('the asset manifest keeps naming the scripts that ship, each emitted by a declared entry', () => {
  const manifest = JSON.parse(read(`${plugin}/Assets/PosterTags/manifest.json`));
  const shipped = JSON.parse(read('client/generated-manifest.json'));
  const outputs = new Set(shipped.entries.map(entry => entry.output));
  for (const input of ['tags/awardstags.js', 'tags/genretags.js', 'tags/qualitytags.js', 'tags/rating-sources.js', 'core/media-language.js']) {
    assert.ok(`${plugin}/js/${input}` in manifest.inputs, input);
    assert.ok(outputs.has(`js/${input}`), `${input} is emitted by client-build`);
  }
});

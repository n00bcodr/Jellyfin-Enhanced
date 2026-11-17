// The further filters of a discovery section (discovery-filters.js, discovery-filter-panel.js): the pure
// logic, the lists asked of the server, and the Filters button, its menu, the line of what is set and the
// note when nothing matches, driven as a viewer drives them. The section's own controller (paging, the
// sort, the join) is not loaded: a section here is a header and a list, reloaded at once from fixtures by
// what the filters ask, so each assertion is about what this package does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, englishT, jsRoot, plain } from '../helpers/harness.mjs';

const DISCOVERY = 'jellyseerr/discovery';
const API = '/JellyfinEnhanced';
// The section, the menu, the busy state and the role line are other packages' modules: loaded where they exist.
const NEIGHBOURS = ['discovery-busy.js', 'discovery-menu.js', 'discovery-roles.js', 'discovery-section.js'].map(file => `${DISCOVERY}/${file}`);
const hasMenu = existsSync(resolve(jsRoot, `${DISCOVERY}/discovery-menu.js`)) && existsSync(resolve(jsRoot, `${DISCOVERY}/discovery-section.js`));

/** Deep equality across the test's realm and the page's (arrays and objects made in the page have its prototypes). */
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);

async function until(condition, label = 'condition') {
  const deadline = performance.now() + 3000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), `${label} was not reached`);
}

/** A harness with the two modules of this package, and its neighbours where they exist. */
function setup(t, { config = {}, lists = [], genres = { movie: [], tv: [] } } = {}) {
  const h = createHarness({ JE: { pluginConfig: config, t: englishT } });
  t.after(() => h.close());
  const asked = [];
  const table = new Map(lists);
  h.JE.discoveryFilter = {
    MODES: { MIXED: 'mixed', MOVIES: 'movies', TV: 'tv' },
    getFilterMode: () => 'mixed',
    async fetchWithManagedRequest(path, prefix) {
      asked.push([path, prefix]);
      if (!table.has(path)) throw new Error(`no fixture for ${path}`);
      return structuredClone(table.get(path));
    },
    fetchTmdbGenreList: async kind => genres[kind]
  };
  for (const file of NEIGHBOURS) if (existsSync(resolve(jsRoot, file))) h.load(file);
  h.load(`${DISCOVERY}/discovery-filters.js`);
  h.load(`${DISCOVERY}/discovery-filter-panel.js`);
  return { ...h, asked, F: h.JE.discoveryFilters };
}

/**
 * A section as the controller makes it: a header with a bar, then the list. Each reload asks for both
 * feeds with what the filters add (or keeps a person's titles), shows what the fixtures answer, and lets
 * the filters say when nothing matches.
 */
function section(h, { name, scope = 'feed', feeds = {}, titles = [], ownGenre } = {}) {
  const { document } = h;
  const root = document.createElement('div');
  root.className = `verticalSection jellyseerr-${name}-discovery-section jellyseerr-discovery-section`;
  const header = document.createElement('div');
  header.className = 'jellyseerr-discovery-header';
  const bar = document.createElement('div');
  bar.className = 'jellyseerr-discovery-bar';
  header.appendChild(bar);
  const list = document.createElement('div');
  list.className = 'itemsContainer';
  root.append(header, list);
  document.body.appendChild(root);
  const queries = [];
  const card = id => { const one = document.createElement('div'); one.className = 'card'; one.dataset.id = String(id); return one; };
  const reload = () => {
    let shown;
    if (scope === 'person') shown = h.F.keep(name, titles).map(item => item.id);
    else {
      shown = [];
      for (const kind of ['tv', 'movie']) {
        const query = h.F.feedQuery(name, kind);
        queries.push(`${kind}${query}`);
        shown.push(...(feeds[`${kind}${query}`] ?? []));
      }
    }
    list.replaceChildren(...shown.map(card));
    h.F.noteIfEmpty(name, list, false);
  };
  const button = h.F.createFiltersControl(header, name, scope, reload, ownGenre);
  bar.appendChild(button);
  reload();
  return { root, header, list, button, queries, shown: () => [...list.querySelectorAll('.card')].map(one => Number(one.dataset.id)) };
}

const menuOf = h => h.document.querySelector('.jellyseerr-sort-menu');
const groupOf = (h, id) => menuOf(h).querySelector(`.jellyseerr-menu-group[data-toggle="${id}"]`);
const bodyOf = (h, id) => { if (groupOf(h, id).getAttribute('aria-expanded') !== 'true') groupOf(h, id).click(); return groupOf(h, id).nextElementSibling; };
/** Types into a field and leaves it, which takes what was typed at once. */
const typeInto = (h, input, value) => { input.value = value; input.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
const typeRange = (h, id, from, to) => { const [low, high] = bodyOf(h, id).querySelectorAll('.jellyseerr-menu-input'); if (from !== null) typeInto(h, low, from); if (to !== null) typeInto(h, high, to); };
const tickRow = (h, id, name) => [...bodyOf(h, id).querySelectorAll('.actionSheetMenuItem')].find(row => row.querySelector('.actionSheetItemText').textContent === name).click();
const FILTER_LISTS = [
  [`${API}/jellyseerr/filters/languages`, [{ iso_639_1: 'fr', english_name: 'French' }, { iso_639_1: 'ja', english_name: 'Japanese' }, { iso_639_1: 'xx', english_name: 'No Language' }]],
  [`${API}/jellyseerr/filters/certifications/movie`, { certifications: { US: [{ certification: 'PG', order: 2 }, { certification: 'G', order: 1 }] } }],
  [`${API}/jellyseerr/filters/certifications/tv`, { certifications: { US: [{ certification: 'TV-PG', order: 4 }] } }],
  [`${API}/jellyseerr/filters/watchproviders/movie?watchRegion=US`, [{ id: 337, name: 'Disney Plus', displayPriority: 3 }, { id: 8, name: 'Netflix', displayPriority: 1 }]],
  [`${API}/jellyseerr/filters/watchproviders/tv?watchRegion=US`, [{ id: 8, name: 'Netflix', displayPriority: 1 }]],
  [`${API}/tmdb/search/keyword?query=sheep`, { results: [{ id: 3020, name: 'sheep' }, { id: 219906, name: 'sheep farm' }] }]
];
const COMEDY = { movie: [{ id: 36, name: 'Comedy' }], tv: [{ id: 35, name: 'Comedy' }] };

// ---- Pure logic ---------------------------------------------------------------------------------

test('dayOf reads a year, a month or a day as its first or last day, month ends and leap years included', t => {
  const { F } = setup(t);
  assert.equal(F.dayOf('2015', false), '2015-01-01');
  assert.equal(F.dayOf(' 2015 ', true), '2015-12-31');
  assert.equal(F.dayOf('2015-06', false), '2015-06-01');
  assert.equal(F.dayOf('2015-06', true), '2015-06-30');
  assert.equal(F.dayOf('2015-01', true), '2015-01-31');
  assert.equal(F.dayOf('2015-12', true), '2015-12-31');
  // February: 28 days, 29 in a leap year (every fourth, not a century's, but every fourth century's).
  assert.equal(F.dayOf('2023-02', true), '2023-02-28');
  assert.equal(F.dayOf('2024-02', true), '2024-02-29');
  assert.equal(F.dayOf('1900-02', true), '1900-02-28');
  assert.equal(F.dayOf('2000-02', true), '2000-02-29');
  assert.equal(F.dayOf('2015-06-30', false), '2015-06-30');
  assert.equal(F.dayOf('2015-06-30', true), '2015-06-30');
  for (const typed of ['', '15', '20155', '2015-13', '2015-00', '2015-6', '2015-06-32', '2015/06', 'soon']) assert.equal(F.dayOf(typed, false), null, typed);
});

test('numberOf and isBound keep each filter to its own limits', t => {
  const { F } = setup(t);
  assert.equal(F.numberOf('score', '7.5'), 7.5);
  assert.equal(F.numberOf('score', '7,5'), 7.5);
  assert.equal(F.numberOf('score', '10'), 10);
  assert.equal(F.numberOf('score', '10.5'), null);
  assert.equal(F.numberOf('score', '7.55'), null);
  assert.equal(F.numberOf('votes', '500'), 500);
  assert.equal(F.numberOf('votes', '1.5'), null);
  assert.equal(F.numberOf('runtime', '12345678'), null);
  assert.equal(F.isBound('score', '', false), true);
  assert.equal(F.isBound('score', 'high', false), false);
  assert.equal(F.isBound('year', '2015-06', true), true);
  assert.equal(F.isBound('year', '2015-13', true), false);
});

test('isReversed is true only for two usable bounds the wrong way round', t => {
  const { F } = setup(t);
  assert.equal(F.isReversed('year', ['2010', '1990']), true);
  assert.equal(F.isReversed('year', ['2019-06-30', '2010']), true);
  // A year and a month of it overlap: the year's first day is before the month's last.
  assert.equal(F.isReversed('year', ['2010', '2010-06']), false);
  assert.equal(F.isReversed('year', ['2010-07', '2010-06']), true);
  assert.equal(F.isReversed('score', ['8', '7.5']), true);
  assert.equal(F.isReversed('score', ['7.5', '8']), false);
  assert.equal(F.isReversed('votes', ['100', '']), false);
  assert.equal(F.isReversed('votes', ['x', '1']), false);
  assert.equal(F.isReversed('runtime', ['90', '90']), false);
});

test('feedFilterQuery asks each kind by its own names, in a fixed order, and asks for nothing where a kind cannot match', t => {
  const { F } = setup(t);
  assert.equal(F.feedFilterQuery({}, 'tv', 'US'), '');
  assert.equal(F.feedFilterQuery({ year: ['2010', '2019-06'] }, 'tv', 'US'), '&firstAirDateGte=2010-01-01&firstAirDateLte=2019-06-30');
  assert.equal(F.feedFilterQuery({ year: ['2010', ''] }, 'movie', 'US'), '&primaryReleaseDateGte=2010-01-01');
  // A bound that cannot be used asks nothing; the other still counts.
  assert.equal(F.feedFilterQuery({ score: ['high', '9'], votes: ['100', ''], runtime: ['', '30'] }, 'movie', 'US'), '&voteAverageLte=9&voteCountGte=100&withRuntimeLte=30');
  const everything = {
    runtime: ['', '30'], votes: ['100', ''], year: ['2000', ''], score: ['7,5', ''],
    genres: [{ id: '36/35', name: 'Comedy' }, { id: '18/18', name: 'Drama' }],
    language: [{ id: 'fr', name: 'French' }, { id: 'ja', name: 'Japanese' }],
    rating: [{ id: 'movie:US:G', name: 'G' }, { id: 'tv:US:TV-PG', name: 'TV-PG' }, { id: 'tv:US:TV-14', name: 'TV-14' }],
    services: [{ id: '8', name: 'Netflix' }, { id: '337', name: 'Disney Plus' }],
    keywords: [{ id: '3020', name: 'sheep' }, { id: '1', name: 'farm' }],
    without: [{ id: '9', name: 'gore' }]
  };
  assert.equal(F.feedFilterQuery(everything, 'tv', 'GB'),
    '&firstAirDateGte=2000-01-01&voteAverageGte=7.5&voteCountGte=100&withRuntimeLte=30&genre=35%2C18&language=fr%7Cja'
    + '&certification=TV-PG%7CTV-14&certificationCountry=US&watchProviders=8%7C337&watchRegion=GB&keywords=3020%2C1&excludeKeywords=9');
  assert.equal(F.feedFilterQuery(everything, 'movie', 'GB'),
    '&primaryReleaseDateGte=2000-01-01&voteAverageGte=7.5&voteCountGte=100&withRuntimeLte=30&genre=36%2C18&language=fr%7Cja'
    + '&certification=G&certificationCountry=US&watchProviders=8%7C337&watchRegion=GB&keywords=3020%2C1&excludeKeywords=9');
  // A genre TMDB has for movies only: the series feed is asked for a time nothing was released in, whatever else is set.
  const horror = { genres: [{ id: '27/', name: 'Horror' }], score: ['7', ''] };
  assert.equal(F.feedFilterQuery(horror, 'tv', 'US'), '&firstAirDateLte=1800-01-01');
  assert.equal(F.feedFilterQuery(horror, 'movie', 'US'), '&voteAverageGte=7&genre=27');
  assert.equal(F.feedFilterQuery({ genres: [{ id: '/10759', name: 'Action & Adventure' }] }, 'movie', 'US'), '&primaryReleaseDateLte=1800-01-01');
  // Ratings are per kind and per country: only movies' ticked, the series feed wants nothing.
  const film = { rating: [{ id: 'movie:GB:15', name: '15' }] };
  assert.equal(F.feedFilterQuery(film, 'movie', 'GB'), '&certification=15&certificationCountry=GB');
  assert.equal(F.feedFilterQuery(film, 'tv', 'GB'), '&firstAirDateLte=1800-01-01');
});

test('keepByFilters keeps a person\'s titles by role, period, score, votes, every genre and any language', t => {
  const { F } = setup(t);
  const titles = [
    { id: 1, mediaType: 'movie', releaseDate: '1995-03-01', voteAverage: 8.1, voteCount: 900, genreIds: [35, 18], originalLanguage: 'fr', jeCredit: { acted: true, departments: ['Directing'] } },
    { id: 2, mediaType: 'tv', firstAirDate: '1999-12-31', voteAverage: 6.9, voteCount: 300, genreIds: [35], originalLanguage: 'ja', jeCredit: { acted: false, departments: ['Writing'] } },
    { id: 3, mediaType: 'movie', jeCredit: { acted: false, departments: ['Writing'] } }
  ];
  const kept = selection => F.keepByFilters(titles, selection).map(item => item.id);
  assert.equal(F.keepByFilters(titles, {}), titles);
  same(kept({ role: [{ id: 'cast' }] }), [1]);
  same(kept({ role: [{ id: 'Writing' }, { id: 'Directing' }] }), [1, 2, 3]);
  // No date is outside every period; a month is its first day to its last.
  same(kept({ year: ['1990', '1999'] }), [1, 2]);
  same(kept({ year: ['1999-12', ''] }), [2]);
  // No score or votes is under every minimum (and inside every maximum).
  same(kept({ votes: ['500', ''] }), [1]);
  same(kept({ score: ['', '7'] }), [2, 3]);
  // Every genre chosen, by the title's own kind; a genre its kind lacks keeps nothing of that kind.
  same(kept({ genres: [{ id: '35/35' }] }), [1, 2]);
  same(kept({ genres: [{ id: '35/35' }, { id: '18/18' }] }), [1]);
  same(kept({ genres: [{ id: '35/' }] }), [1]);
  same(kept({ language: [{ id: 'ja' }, { id: 'en' }] }), [2]);
  // Without genres: none of them, by the title's own kind (a title that names no genres has none of them).
  same(kept({ withoutGenres: [{ id: '18/18' }] }), [2, 3]);
  same(kept({ withoutGenres: [{ id: '35/' }] }), [2, 3]);
  same(kept({ withoutGenres: [{ id: '35/35' }] }), [3]);
  // Without language: not originally in any of them.
  same(kept({ withoutLanguage: [{ id: 'ja' }] }), [1, 3]);
  same(kept({ genres: [{ id: '35/35' }], withoutLanguage: [{ id: 'fr' }] }), [2]);
});

test('offeredFilters leaves out what the admin turned off; a missing switch is on', t => {
  const { F } = setup(t);
  same(F.offeredFilters('feed', null), ['year', 'score', 'votes', 'runtime', 'genres', 'withoutGenres', 'language', 'withoutLanguage', 'rating', 'services', 'keywords', 'without']);
  same(F.offeredFilters('person', undefined), ['role', 'year', 'score', 'votes', 'genres', 'withoutGenres', 'language', 'withoutLanguage']);
  // A list and its Without share one switch (the two keyword filters, genres, languages).
  same(F.offeredFilters('feed', { JellyseerrFilterKeywords: false, JellyseerrFilterStreaming: false, JellyseerrFilterYear: true }),
    ['year', 'score', 'votes', 'runtime', 'genres', 'withoutGenres', 'language', 'withoutLanguage', 'rating']);
  same(F.offeredFilters('person', { JellyseerrFilterRole: false, JellyseerrFilterVotes: false, JellyseerrFilterRuntime: false, JellyseerrFilterLanguage: false }),
    ['year', 'score', 'genres', 'withoutGenres']);
  const off = Object.fromEntries(Object.values(F.FILTER_SWITCHES).map(name => [name, false]));
  same(F.offeredFilters('feed', off), []);
  same(F.offeredFilters('person', off), []);
});

test('rolesOf offers acting first, then departments by how many credits, the catch-all last', t => {
  const { F } = setup(t);
  const credit = (acted, departments) => ({ jeCredit: { acted, departments } });
  const roles = F.rolesOf([credit(false, ['Crew', 'Writing']), credit(true, ['Writing', 'Directing']), credit(false, ['Crew', 'Art'])], 'Acting', name => `<${name}>`);
  same(roles, [{ id: 'cast', name: 'Acting' }, { id: 'Writing', name: '<Writing>' }, { id: 'Art', name: '<Art>' }, { id: 'Directing', name: '<Directing>' }, { id: 'Crew', name: '<Crew>' }]);
  same(F.rolesOf([credit(false, ['Sound'])], 'Acting', name => name), [{ id: 'Sound', name: 'Sound' }]);
  same(F.rolesOf([{ id: 1 }], 'Acting', name => name), []);
});

test('the lists are asked once per visit, named and ordered for the eye; a failed list is asked again', async t => {
  const { F } = setup(t);
  let calls = 0;
  let failNext = true;
  const bodies = new Map(FILTER_LISTS);
  bodies.set(`${API}/jellyseerr/filters/certifications/movie`, { certifications: { GB: [{ certification: '15', order: 4 }, { certification: 'U', order: 1 }], US: [{ certification: 'G', order: 1 }] } });
  const data = F.createFilterData({
    region: 'GB',
    async fetch(path) {
      calls++;
      if (path.endsWith('/languages') && failNext) { failNext = false; throw new Error('down'); }
      return bodies.get(path.replace('watchRegion=GB', 'watchRegion=US'));
    },
    fetchGenres: async kind => kind === 'movie' ? [{ id: 28, name: 'Action' }, { id: 27, name: 'Horror' }, { id: 35, name: 'Comedy' }] : [{ id: 35, name: 'comedy' }, { id: 10759, name: 'Action & Adventure' }]
  });
  same(await data.genres(), [{ id: '28/', name: 'Action' }, { id: '/10759', name: 'Action & Adventure' }, { id: '35/35', name: 'Comedy' }, { id: '27/', name: 'Horror' }]);
  await assert.rejects(data.languages('en'));
  // ("xx" is TMDB's "no language".)
  same(await data.languages('en'), [{ id: 'fr', name: 'French' }, { id: 'ja', name: 'Japanese' }]);
  const before = calls;
  await data.languages('en');
  assert.equal(calls, before);
  // The region's own ratings where TMDB has them, the US's otherwise; mildest first.
  same(await data.ratings(), [
    { kind: 'movie', ratings: [{ id: 'movie:GB:U', name: 'U' }, { id: 'movie:GB:15', name: '15' }] },
    { kind: 'tv', ratings: [{ id: 'tv:US:TV-PG', name: 'TV-PG' }] }
  ]);
  // One service once, the widest known first.
  same(await data.services(), [{ id: '8', name: 'Netflix' }, { id: '337', name: 'Disney Plus' }]);
  same(await data.searchKeywords('sheep', new AbortController().signal), [{ id: '3020', name: 'sheep' }, { id: '219906', name: 'sheep farm' }]);
  assert.equal(data.region, 'GB');
});

test('what is set is said piece by piece: a range once, in the viewer\'s numbers, a list per thing ticked', t => {
  const { F, JE } = setup(t);
  const offered = F.offeredFilters('feed', {});
  const label = (key, fallback, values) => {
    let said = JE.t(key, values) === key ? fallback : JE.t(key, values);
    for (const [name, value] of Object.entries(values ?? {})) said = said.replace(`{${name}}`, String(value));
    return said;
  };
  const tokens = F.filterTokens({ offered, label, locale: 'en', selection: {
    year: ['2019', '2010'], votes: ['1000', ''], runtime: ['', '90'], score: ['x', ''],
    language: [{ id: 'fr', name: 'French' }], keywords: [{ id: '1', name: 'robot' }], without: [{ id: '2', name: 'gore' }], services: [{ id: '8', name: 'Netflix' }]
  } });
  // A reversed range is read the one way it can mean; what cannot be used is not said.
  same(tokens.map(token => token.words), ['Released 2010 to 2019', 'Votes from 1,000', 'Runtime up to 90 min', 'Originally in French', 'On Netflix', 'With robot', 'Without gore']);
  same(tokens[0].without({ year: ['2019', '2010'], votes: ['1', ''] }), { year: undefined, votes: ['1', ''] });
  same(tokens[3].without({ language: [{ id: 'fr' }, { id: 'ja' }] }), { language: [{ id: 'ja' }] });
  same(tokens[3].without({ language: [{ id: 'fr' }] }), { language: undefined });
});

test('the services and the feed ask for the admin\'s region; an unusable region is the US', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const providers = kind => [`${API}/jellyseerr/filters/watchproviders/${kind}?watchRegion=GB`, [{ id: 8, name: 'Netflix', displayPriority: 1 }]];
  const h = setup(t, { config: { DEFAULT_REGION: ' gb ' }, lists: [providers('movie'), providers('tv')] });
  assert.equal(h.F.feedQuery('genre', 'tv'), '');
  assert.equal(h.F.active('genre'), false);
  const s = section(h, { name: 'genre' });
  s.button.click();
  await until(() => bodyOf(h, 'services').querySelectorAll('.actionSheetMenuItem').length === 1, 'services');
  tickRow(h, 'services', 'Netflix');
  assert.ok(h.F.active('genre'));
  assert.equal(h.F.feedQuery('genre', 'movie'), '&watchProviders=8&watchRegion=GB');
  h.JE.pluginConfig.DEFAULT_REGION = 'GBR';
  assert.equal(h.F.feedQuery('genre', 'movie'), '&watchProviders=8&watchRegion=US');
  // A section starts with nothing narrowing it; what is not there is left alone.
  h.F.reset('genre');
  same(h.F.selectionOf('genre'), {});
  assert.equal(h.F.feedQuery('genre', 'movie'), '');
  same(h.F.keep('person', [{ id: 1 }]), [{ id: 1 }]);
  h.F.repaint(null);
  h.F.noteIfEmpty('genre', null, false);
});

// ---- The Filters button, its menu, the line of what is set ----------------------------------------

test('a list page\'s further filters are typed or ticked, and asked of Seerr: ranges by each feed\'s own names, lists whole', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const h = setup(t, { lists: FILTER_LISTS, genres: COMEDY });
  const feeds = {
    tv: [1, 2], movie: [11, 12],
    'tv&voteAverageGte=7.5': [3], 'movie&voteAverageGte=7.5': [13],
    'tv&firstAirDateGte=2010-01-01&firstAirDateLte=2019-06-30&voteAverageGte=7.5': [4],
    'movie&primaryReleaseDateGte=2010-01-01&primaryReleaseDateLte=2019-06-30&voteAverageGte=7.5': [14],
    'tv&voteCountGte=100&withRuntimeLte=30&language=fr%7Cja&certification=TV-PG&certificationCountry=US&watchProviders=8&watchRegion=US&keywords=3020': [5],
    'movie&voteCountGte=100&withRuntimeLte=30&language=fr%7Cja&certification=G&certificationCountry=US&watchProviders=8&watchRegion=US&keywords=3020': []
  };
  const s = section(h, { name: 'genre', feeds, ownGenre: 'Comedy' });
  const shown = () => String(s.shown());
  assert.equal(shown(), '1,2,11,12');
  const { button } = s;
  assert.ok(button.matches('button.emby-tab-button.emby-button[aria-haspopup="dialog"][aria-expanded="false"]:not([aria-label])'));
  // Its name is what it holds: "Filters" (out of sight; the icon says it to the eye), then the type's word where that shows.
  same([...button.children].map(child => [child.className.split(' ').pop(), child.textContent]), [['filter_alt', ''], ['jellyseerr-filters-name', 'Filters'], ['jellyseerr-filters-type', '']]);
  assert.ok(h.document.getElementById('jellyseerr-discovery-filter-panel-styles'));
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  // It holds fields, so it is a dialog of rows that open (not a menu of items); with nothing set there is nothing to clear.
  assert.ok(menuOf(h).matches('[role="dialog"][aria-label="Filters"]'));
  assert.equal(menuOf(h).querySelector('.jellyseerr-menu-foot > .jellyseerr-menu-clear').getAttribute('aria-disabled'), 'true');
  // Every filter is a group that says nothing is set; none is open.
  same([...menuOf(h).querySelectorAll('.jellyseerr-menu-group')].map(group => group.textContent),
    ['ReleasedAny', 'ScoreAny', 'VotesAny', 'RuntimeAny', 'GenresAny', 'Without genresNone', 'Original languageAny', 'Without languageNone', 'Content ratingAny', 'Streaming servicesAny', 'KeywordsAny', 'Without keywordsNone']);
  assert.equal(menuOf(h).querySelectorAll('.jellyseerr-menu-choices:not([hidden])').length, 0);
  // A score is typed, decimals and all; what cannot be a score is marked and asks nothing.
  const hintOf = id => bodyOf(h, id).querySelector('.jellyseerr-menu-note');
  assert.equal(hintOf('score').textContent, 'From 0 to 10; one decimal, such as 7.5.');
  typeRange(h, 'score', 'high', null);
  assert.equal(bodyOf(h, 'score').querySelector('.jellyseerr-menu-input').getAttribute('aria-invalid'), 'true');
  // What cannot be used is said in words where the hint was, and the field points to it.
  assert.equal(hintOf('score').textContent, 'Type a score from 0 to 10, such as 7.5.');
  assert.ok(hintOf('score').hasAttribute('data-error'));
  assert.equal(bodyOf(h, 'score').querySelector('.jellyseerr-menu-input').getAttribute('aria-describedby'), hintOf('score').id);
  assert.equal(button.hasAttribute('data-on'), false);
  assert.equal(s.queries.length, 2);
  typeRange(h, 'score', '', null);
  assert.equal(hintOf('score').textContent, 'From 0 to 10; one decimal, such as 7.5.');
  typeRange(h, 'score', '7.5', null);
  assert.equal(shown(), '3,13');
  assert.equal(bodyOf(h, 'score').querySelector('.jellyseerr-menu-input').hasAttribute('aria-invalid'), false);
  assert.equal(groupOf(h, 'score').textContent, 'ScoreFrom 7.5');
  assert.ok(groupOf(h, 'score').hasAttribute('data-set'));
  assert.ok(button.hasAttribute('data-on'));
  assert.equal(button.querySelector('.jellyseerr-filters-name').textContent, 'Filters: 1');
  assert.equal(hintOf('score').hasAttribute('data-error'), false);
  assert.equal(menuOf(h).querySelector('.jellyseerr-menu-clear').hasAttribute('aria-disabled'), false);
  // What is set is said under the header, in words, with the way to take it away.
  const setLine = () => s.root.querySelector('.jellyseerr-discovery-header + .jellyseerr-filters-set');
  assert.ok(setLine().matches('[role="group"][aria-label="Filters"]'));
  same([...setLine().querySelectorAll('.jellyseerr-filters-token')].map(token => [token.textContent, token.querySelector('button').getAttribute('aria-label')]), [['Score from 7.5', 'Remove: Score from 7.5']]);
  // A year, or a day of one; each feed is asked by its own date.
  typeRange(h, 'year', '2010', '2019-06-30');
  assert.equal(shown(), '4,14');
  assert.equal(groupOf(h, 'year').textContent, 'Released2010 to 2019-06-30');
  // Typed the wrong way round, a range has one meaning and is read so; the fields stay as typed.
  typeRange(h, 'year', '2019-06-30', '2010');
  assert.equal(groupOf(h, 'year').textContent, 'Released2010 to 2019-06-30');
  same([...bodyOf(h, 'year').querySelectorAll('.jellyseerr-menu-input')].map(input => [input.value, input.hasAttribute('aria-invalid')]), [['2019-06-30', false], ['2010', false]]);
  assert.equal(shown(), '4,14');
  // The genre of the page is given: every title is in it, so it is ticked and cannot be changed.
  await until(() => bodyOf(h, 'genres').querySelectorAll('.actionSheetMenuItem').length === 1, 'genres');
  same([...bodyOf(h, 'genres').querySelectorAll('.actionSheetMenuItem')].map(row => [row.textContent, row.getAttribute('aria-checked'), row.getAttribute('aria-disabled')]), [['ComedyIncluded by this page', 'true', 'true']]);
  // (The row says why, under its name; the choice beside it is named with its list, for a reader that comes to it alone.)
  assert.equal(bodyOf(h, 'genres').querySelector('.jellyseerr-menu-given').textContent, 'Included by this page');
  assert.equal(bodyOf(h, 'genres').querySelector('[role="radiogroup"]').getAttribute('aria-label'), 'Genres: Titles in Comedy and');
  // The lists are Seerr's whole lists (less TMDB's "no language"), each ticked on its own row.
  typeRange(h, 'year', '', '');
  typeRange(h, 'score', '', '');
  typeRange(h, 'votes', '100', null);
  typeRange(h, 'runtime', null, '30');
  await until(() => bodyOf(h, 'language').querySelectorAll('.actionSheetMenuItem').length === 2, 'languages');
  tickRow(h, 'language', 'French'); tickRow(h, 'language', 'Japanese');
  // A row to tick has a box, empty or ticked (several of a list can be).
  same([...bodyOf(h, 'language').querySelectorAll('.actionSheetMenuItem')].map(row => [row.getAttribute('role'), row.getAttribute('aria-checked'), row.querySelector('.actionsheetMenuItemIcon').className.split(' ').pop()]),
    [['checkbox', 'true', 'check_box'], ['checkbox', 'true', 'check_box']]);
  await until(() => bodyOf(h, 'rating').querySelectorAll('.actionSheetMenuItem').length === 3, 'ratings');
  // Ratings are in order of strictness, movies' and series' apart; each kind's feed is asked for its own.
  same([...bodyOf(h, 'rating').querySelectorAll('.jellyseerr-menu-label, .actionSheetItemText')].map(node => node.textContent), ['Movies', 'G', 'PG', 'Series', 'TV-PG']);
  // (A page of one kind offers that kind's ratings only; Movies on the tabs, the same.)
  s.root.querySelector('.jellyseerr-discovery-header').setAttribute('data-je-kinds', 'movie');
  h.document.querySelector('.dialogBackdrop').click();
  button.click();
  await until(() => bodyOf(h, 'rating').querySelectorAll('.actionSheetMenuItem').length === 2, 'movie ratings only');
  same([...bodyOf(h, 'rating').querySelectorAll('.jellyseerr-menu-label, .actionSheetItemText')].map(node => node.textContent), ['Movies', 'G', 'PG']);
  s.root.querySelector('.jellyseerr-discovery-header').removeAttribute('data-je-kinds');
  h.document.querySelector('.dialogBackdrop').click();
  button.click();
  await until(() => bodyOf(h, 'rating').querySelectorAll('.actionSheetMenuItem').length === 3, 'both kinds again');
  tickRow(h, 'rating', 'G'); tickRow(h, 'rating', 'TV-PG');
  await until(() => bodyOf(h, 'services').querySelectorAll('.actionSheetMenuItem').length === 2, 'services');
  same([...bodyOf(h, 'services').querySelectorAll('.actionSheetItemText')].map(node => node.textContent), ['Netflix', 'Disney Plus']);
  tickRow(h, 'services', 'Netflix');
  const search = bodyOf(h, 'keywords').querySelector('.jellyseerr-menu-search');
  search.value = 'sheep';
  search.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => bodyOf(h, 'keywords').querySelectorAll('.actionSheetMenuItem').length === 2, 'keywords found');
  tickRow(h, 'keywords', 'sheep');
  assert.equal(shown(), '5');
  // (A language and a rating are any of the ones ticked, Seerr's own rule for them: said so, as a chosen any is.)
  assert.equal(groupOf(h, 'language').textContent, 'Original languageFrench or Japanese');
  assert.equal(groupOf(h, 'rating').textContent, 'Content ratingG or TV-PG');
  assert.equal(groupOf(h, 'keywords').textContent, 'Keywordssheep');
  // A keyword chosen is kept above the field, and the field is empty for the next.
  assert.equal(search.value, '');
  same([...bodyOf(h, 'keywords').querySelectorAll('.actionSheetItemText')].map(node => node.textContent), ['sheep']);
  assert.equal(button.querySelector('.jellyseerr-filters-name').textContent, 'Filters: 6');
  // One piece per thing set, a list's things each on their own; several can be cleared at once.
  same([...setLine().querySelectorAll('.jellyseerr-filters-token')].map(piece => piece.textContent), ['Votes from 100', 'Runtime up to 30 min', 'Originally in French', 'or Japanese', 'G', 'or TV-PG', 'On Netflix', 'With sheep']);
  same([...setLine().children].map(piece => piece.getAttribute('aria-label') ?? piece.className), ['jellyseerr-filters-token', 'jellyseerr-filters-token', 'Original language', 'Content rating', 'jellyseerr-filters-token', 'jellyseerr-filters-token', 'jellyseerr-filters-clear']);
  // The lists are asked like every other lookup of these sections, once each.
  assert.ok(h.asked.every(([, prefix]) => prefix === 'filters'));
  assert.equal(h.asked.filter(([path]) => path.endsWith('/languages')).length, 1);
  // "Clear filters" puts the list and every group back.
  menuOf(h).querySelector('.jellyseerr-menu-clear').click();
  assert.equal(shown(), '1,2,11,12');
  same([...menuOf(h).querySelectorAll('.jellyseerr-menu-group')].map(group => group.hasAttribute('data-set')), Array(12).fill(false));
  assert.equal(button.hasAttribute('data-on'), false);
  assert.equal(setLine(), null);
  h.document.querySelector('.dialogBackdrop').click();
  assert.equal(menuOf(h), null);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('nothing matches: the section says so and offers the way out; the admin\'s switches take a filter away for good', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const h = setup(t, { config: { JellyseerrFilterStreaming: false, JellyseerrFilterKeywords: false }, genres: COMEDY });
  const s = section(h, { name: 'genre', feeds: { tv: [1, 2], movie: [11, 12], 'tv&firstAirDateLte=1899-12-31': [], 'movie&primaryReleaseDateLte=1899-12-31': [] } });
  s.button.click();
  same([...menuOf(h).querySelectorAll('.jellyseerr-menu-group')].map(group => group.dataset.toggle), ['year', 'score', 'votes', 'runtime', 'genres', 'withoutGenres', 'language', 'withoutLanguage', 'rating']);
  typeRange(h, 'year', null, '1899');
  same(s.shown(), []);
  const none = () => s.root.querySelector('.itemsContainer + .jellyseerr-filters-none');
  assert.ok(none());
  assert.equal(none().querySelector('span').textContent, 'Nothing matches these filters.');
  assert.equal(none().querySelector('button').textContent, 'Clear filters');
  // The menu says it too, over its foot (where it covers the list, the page can't be seen saying it).
  await until(() => menuOf(h).querySelector('.jellyseerr-menu-outcome:not([hidden])'), 'the menu says nothing matches');
  const outcome = menuOf(h).querySelector('.jellyseerr-menu-outcome');
  assert.equal(outcome.firstElementChild.textContent, 'Nothing matches these filters.');
  assert.equal(outcome.getAttribute('role'), 'status');
  // With the way back from that change alone: Undo puts the filters as they were, and the menu says every group again.
  const undo = outcome.querySelector('.jellyseerr-menu-outcome-undo');
  // (Its words say what it undoes: what the last change set.)
  same([undo.textContent, undo.getAttribute('aria-label')], ['Undo Released up to 1899', null]);
  undo.click();
  same(s.shown(), [1, 2, 11, 12]);
  assert.equal(groupOf(h, 'year').textContent, 'ReleasedAny');
  same([...bodyOf(h, 'year').querySelectorAll('.jellyseerr-menu-input')].map(input => input.value), ['', '']);
  await until(() => menuOf(h).querySelector('.jellyseerr-menu-outcome[hidden]'), 'and stops when something does');
  typeRange(h, 'year', null, '1899');
  h.document.querySelector('.dialogBackdrop').click();
  // (Opened again on a list that has nothing, with no change made here since: nothing to undo, no Undo offered.)
  s.button.click();
  await until(() => menuOf(h).querySelector('.jellyseerr-menu-outcome:not([hidden])'), 'said again');
  assert.equal(menuOf(h).querySelector('.jellyseerr-menu-outcome-undo') !== null, true, 'the change before the menu closed can still be undone');
  h.document.querySelector('.dialogBackdrop').click();
  // Pressed with the keys on it, the line's button hands them to the Filters button: the line, and the button with it, goes when the list is back.
  const onLine = none().querySelector('button');
  onLine.focus();
  onLine.click();
  assert.equal(h.document.activeElement, s.button);
  same(s.shown(), [1, 2, 11, 12]);
  assert.equal(none(), null);
  assert.equal(s.button.hasAttribute('data-on'), false);
  assert.equal(s.root.querySelector('.jellyseerr-filters-set'), null);
  // A section whose every filter the admin turned off has a button only for where the tabs are out of sight.
  const all = Object.fromEntries(Object.values(h.F.FILTER_SWITCHES).map(name => [name, false]));
  Object.assign(h.JE.pluginConfig, all);
  const bare = section(h, { name: 'tag', feeds: { tv: [1], movie: [] } });
  assert.ok(bare.button.hasAttribute('data-type-only'));
  bare.button.click();
  assert.equal(menuOf(h), null);
  assert.equal(bare.button.getAttribute('aria-expanded'), 'false');
});

test('a person\'s titles are filtered here: by role, by years, by score and votes, by genre and language', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const h = setup(t, { lists: FILTER_LISTS, genres: { movie: [{ id: 35, name: 'Comedy' }, { id: 27, name: 'Horror' }], tv: [{ id: 35, name: 'Comedy' }] } });
  const titles = [
    { id: 5, mediaType: 'movie', releaseDate: '1995-03-01', voteAverage: 8.1, voteCount: 900, genreIds: [35], originalLanguage: 'fr', jeCredit: { acted: true, characters: ['Ted'], jobs: ['Director'], departments: ['Directing'], crew: [['Director', 'Directing']] } },
    { id: 6, mediaType: 'movie', releaseDate: '2004-01-01', voteAverage: 5, voteCount: 12, genreIds: [27], originalLanguage: 'en', jeCredit: { acted: true, characters: [], jobs: [], departments: [], crew: [] } },
    { id: 7, mediaType: 'tv', firstAirDate: '1999-12-31', voteAverage: 6.9, voteCount: 300, genreIds: [35], originalLanguage: 'ja', jeCredit: { acted: false, characters: [], jobs: ['Writer'], departments: ['Writing'], crew: [['Writer', 'Writing']] } },
    { id: 8, mediaType: 'movie', jeCredit: { acted: false, characters: [], jobs: ['Screenplay'], departments: ['Writing'], crew: [['Screenplay', 'Writing']] } }
  ];
  const s = section(h, { name: 'person', scope: 'person', titles });
  const shown = () => String(s.shown().sort());
  assert.equal(shown(), '5,6,7,8');
  s.button.click();
  // What a person's credits cannot be asked (runtime, rating, services, keywords) is not offered.
  same([...menuOf(h).querySelectorAll('.jellyseerr-menu-group')].map(group => group.dataset.toggle), ['role', 'year', 'score', 'votes', 'genres', 'withoutGenres', 'language', 'withoutLanguage']);
  // The roles are the person's own: acting, then each crew department they have credits in, the most first.
  await until(() => bodyOf(h, 'role').querySelectorAll('.actionSheetMenuItem').length === 3, 'roles');
  same([...bodyOf(h, 'role').querySelectorAll('.actionSheetItemText')].map(node => node.textContent), ['Acting', 'Writing', 'Directing']);
  assert.equal(groupOf(h, 'role').textContent, 'RoleAny');
  // Acting: every title with a cast credit, whether or not the part is named.
  tickRow(h, 'role', 'Acting');
  assert.equal(shown(), '5,6');
  assert.equal(s.root.hasAttribute('data-jobs-first'), false);
  tickRow(h, 'role', 'Acting'); tickRow(h, 'role', 'Writing');
  assert.equal(shown(), '7,8');
  // Asked for by a job and not for acting, the cards put the jobs first, the ones asked for leading.
  assert.ok(s.root.hasAttribute('data-jobs-first'));
  assert.equal(s.root.getAttribute('data-role-asked'), 'Writing');
  // Any of the roles ticked.
  tickRow(h, 'role', 'Directing');
  assert.equal(shown(), '5,7,8');
  assert.equal(groupOf(h, 'role').textContent, 'RoleWriting or Directing');
  assert.equal(s.root.getAttribute('data-role-asked'), 'Writing|Directing');
  // A title with no date is outside every period; one with no votes is under every minimum.
  typeRange(h, 'year', '1990', '1999');
  assert.equal(shown(), '5,7');
  typeRange(h, 'votes', '500', null);
  assert.equal(shown(), '5');
  typeRange(h, 'votes', '', null);
  typeRange(h, 'score', null, '7');
  assert.equal(shown(), '7');
  typeRange(h, 'score', null, '');
  typeRange(h, 'year', '', '');
  // A month is its first day to its last.
  typeRange(h, 'year', '1999-12', '2000-02');
  assert.equal(shown(), '7');
  typeRange(h, 'year', '', '');
  // Taken away on the line under the header, piece by piece.
  h.document.querySelector('.dialogBackdrop').click();
  const pieces = () => [...s.root.querySelectorAll('.jellyseerr-filters-set .jellyseerr-filters-token')];
  same(pieces().map(piece => piece.textContent), ['Writing', 'or Directing']);
  // Taken away with the keys on it, the keys go on to the next piece's own button; with none left, to the Filters button.
  const first = pieces()[0].querySelector('.jellyseerr-filters-remove');
  first.focus();
  first.click();
  assert.equal(shown(), '5');
  assert.equal(h.document.activeElement, pieces()[0].querySelector('.jellyseerr-filters-remove'));
  pieces()[0].querySelector('.jellyseerr-filters-remove').click();
  assert.equal(h.document.activeElement, s.button);
  assert.equal(s.root.querySelector('.jellyseerr-filters-set'), null);
  assert.equal(shown(), '5,6,7,8');
  assert.equal(s.root.getAttribute('data-role-asked'), '');
  s.button.click();
  // A genre by its own number for each kind; "Horror" has none for series.
  await until(() => bodyOf(h, 'genres').querySelectorAll('.actionSheetMenuItem').length === 2, 'genres');
  tickRow(h, 'genres', 'Comedy');
  assert.equal(shown(), '5,7');
  tickRow(h, 'genres', 'Comedy'); tickRow(h, 'genres', 'Horror');
  assert.equal(shown(), '6');
  tickRow(h, 'genres', 'Horror');
  await until(() => bodyOf(h, 'language').querySelectorAll('.actionSheetMenuItem').length === 2, 'languages');
  tickRow(h, 'language', 'Japanese');
  assert.equal(shown(), '7');
  tickRow(h, 'language', 'French');
  assert.equal(shown(), '5,7');
  typeRange(h, 'year', '2020', null);
  assert.equal(shown(), '');
  assert.ok(s.root.querySelector('.jellyseerr-filters-none'));
  // Several set: the line under the header offers to clear them all at once (the note offers the same, so the line's own is hidden by the stylesheet).
  assert.equal(s.root.querySelector('.jellyseerr-filters-set .jellyseerr-filters-clear').textContent, 'Clear filters');
  menuOf(h).querySelector('.jellyseerr-menu-clear').click();
  assert.equal(shown(), '5,6,7,8');
  assert.equal(s.root.querySelector('.jellyseerr-filters-none'), null);
  // A section starts again with nothing narrowing it. (Cleared, a body is built anew when next opened.)
  await until(() => bodyOf(h, 'language').querySelectorAll('.actionSheetMenuItem').length === 2, 'languages again');
  tickRow(h, 'language', 'French');
  assert.ok(h.F.active('person'));
  h.F.reset('person');
  assert.equal(h.F.active('person'), false);
});

test('the tabs\' choice repaints the button: a type other than All is said beside the icon where the tabs are out of sight', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const h = setup(t, { genres: COMEDY });
  let mode = 'mixed';
  const chosen = [];
  h.JE.discoveryFilter.getFilterMode = () => mode;
  const s = section(h, { name: 'genre', feeds: { tv: [1], movie: [11] } });
  const tabs = h.document.createElement('div');
  tabs.dataset.typeGroup = '';
  s.header.querySelector('.jellyseerr-discovery-bar').prepend(tabs);
  let showing = true;
  h.JE.discoveryFilter.typePickerOf = element => element === tabs ? {
    groupOf: () => ({ id: 'type', name: 'Type', choices: [['mixed', 'All'], ['movies', 'Movies'], ['tv', 'Series']].map(([id, name]) => ({ id, name, selected: id === mode })) }),
    choose: next => { chosen.push(next); mode = next; h.F.repaint(tabs); },
    tabsShowing: () => showing
  } : undefined;
  mode = 'movies';
  h.F.repaint(tabs);
  assert.ok(s.button.hasAttribute('data-type-on'));
  assert.equal(s.button.querySelector('.jellyseerr-filters-type').textContent, 'Movies');
  // Where the tabs are in sight, the menu holds only the further filters.
  s.button.click();
  assert.equal(groupOf(h, 'type'), null);
  h.document.querySelector('.dialogBackdrop').click();
  // Out of sight, the type is the menu's first group, open; "Clear filters" puts it back on All.
  showing = false;
  s.button.click();
  assert.equal(groupOf(h, 'type').getAttribute('aria-expanded'), 'true');
  menuOf(h).querySelector('.actionSheetMenuItem[data-group="type"][data-id="tv"]').click();
  same(chosen, ['tv']);
  assert.equal(s.button.querySelector('.jellyseerr-filters-type').textContent, 'Series');
  menuOf(h).querySelector('.jellyseerr-menu-clear').click();
  same(chosen, ['tv', 'mixed']);
  assert.equal(s.button.hasAttribute('data-type-on'), false);
  assert.equal(s.button.querySelector('.jellyseerr-filters-type').textContent, '');
});

test('a list matched by any of what is ticked is asked with a bar, by all of it with a comma; a route naming the list keeps all', t => {
  const h = setup(t);
  const { feedFilterQuery, keepByFilters, routeFeed, matchOf } = h.F;
  const bear = { id: '10468', name: 'bear' };
  const dragon = { id: '12554', name: 'dragon' };
  assert.equal(feedFilterQuery({ keywords: [bear, dragon] }, 'movie', 'US'), '&keywords=10468%2C12554', 'keywords: all by default');
  assert.equal(feedFilterQuery({ keywords: [bear, dragon], match: { keywords: 'any' } }, 'movie', 'US'), '&keywords=10468%7C12554');
  assert.equal(feedFilterQuery({ services: [{ id: '8' }, { id: '337' }] }, 'tv', 'US'), '&watchProviders=8%7C337&watchRegion=US', 'services: any by default');
  assert.equal(feedFilterQuery({ services: [{ id: '8' }, { id: '337' }], match: { services: 'all' } }, 'tv', 'US'), '&watchProviders=8%2C337&watchRegion=US');
  const genres = [{ id: '16/16', name: 'Animation' }, { id: '28/', name: 'Action' }];
  assert.equal(feedFilterQuery({ genres }, 'tv', 'US'), '&firstAirDateLte=1800-01-01', 'all of them: no series is in Action');
  assert.equal(feedFilterQuery({ genres, match: { genres: 'any' } }, 'tv', 'US'), '&genre=16', 'any of them: Action adds nothing for series');
  assert.equal(feedFilterQuery({ genres, match: { genres: 'any' } }, 'movie', 'US'), '&genre=16%7C28');
  assert.equal(matchOf({ match: { genres: 'nonsense' } }, 'genres'), 'all');
  // A person's titles (and Trending's): in every genre ticked, or in any of them.
  const titles = [{ id: 1, mediaType: 'movie', genreIds: [16] }, { id: 2, mediaType: 'movie', genreIds: [16, 28] }, { id: 3, mediaType: 'movie', genreIds: [18] }];
  same(keepByFilters(titles, { genres }).map(item => item.id), [2]);
  same(keepByFilters(titles, { genres, match: { genres: 'any' } }).map(item => item.id), [1, 2]);
  // A genre's page always asks for its own genre. The others: all of them joined to it by Seerr; any of them kept
  // here by each title's genres (TMDB can't say "this genre and any of those" in one request).
  const GENRE_PAGE = '/JellyfinEnhanced/jellyseerr/discover/movies/genre/16';
  const others = [{ id: '16/16', name: 'Animation' }, { id: '10751/10751', name: 'Family' }, { id: '35/35', name: 'Comedy' }];
  const all = routeFeed(GENRE_PAGE, 'movie', { genres: others }, '&sortBy=x&genre=16%2C10751%2C35');
  same([all.query, all.keep], ['&sortBy=x&genre=16%2C10751%2C35', null]);
  const either = routeFeed(GENRE_PAGE, 'movie', { genres: others, match: { genres: 'any' } }, '&sortBy=x&genre=16%7C10751%7C35&keywords=1%7C2');
  assert.equal(either.query, '&sortBy=x&keywords=1%7C2');
  same([{ genreIds: [16, 35] }, { genreIds: [16] }, { genreIds: [10751] }, {}].map(either.keep), [true, false, true, false]);
  // Only kinds TMDB lacks among the others: nothing of this kind is in any of them.
  const kids = routeFeed(GENRE_PAGE, 'movie', { genres: [{ id: '/10762', name: 'Kids' }], match: { genres: 'any' } }, '&genre=');
  same([kids.query, kids.keep], ['&primaryReleaseDateLte=1800-01-01', null]);
  // A tag's page can only add keywords as all of them: a title does not say its keywords.
  same(routeFeed('/JellyfinEnhanced/jellyseerr/discover/tv/keyword/9', 'tv', { match: { keywords: 'any' } }, '&genre=14%7C35&keywords=1%7C2'),
    { query: '&genre=14%7C35&keywords=1%2C2', keep: null });
  same(routeFeed('/JellyfinEnhanced/jellyseerr/discover/movies', 'movie', { match: { genres: 'any' } }, '&genre=14%7C35'), { query: '&genre=14%7C35', keep: null });
  // Without genres and without language: Seerr can't leave them out, so every feed keeps here what is not them.
  const not = routeFeed('/JellyfinEnhanced/jellyseerr/discover/movies', 'movie', { withoutGenres: [{ id: '27/' }, { id: '/9648' }], withoutLanguage: [{ id: 'ja' }] }, '&genre=14');
  assert.equal(not.query, '&genre=14');
  same([{ genreIds: [27, 14] }, { genreIds: [14], originalLanguage: 'ja' }, { genreIds: [14, 9648], originalLanguage: 'en' }, {}].map(not.keep), [false, false, true, true]);
  // With a genre page's own keep: both hold.
  const both = routeFeed(GENRE_PAGE, 'movie', { genres: others, match: { genres: 'any' }, withoutGenres: [{ id: '35/35' }] }, '&genre=16%7C10751%7C35');
  same([{ genreIds: [16, 10751] }, { genreIds: [16, 10751, 35] }, { genreIds: [16] }].map(both.keep), [true, false, false]);
});

test('the Filters menu offers all or any for keywords, genres and services; "or" says it where it is any; a tag page keeps its keywords all', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const h = setup(t, { lists: FILTER_LISTS, genres: COMEDY });
  const feeds = { tv: [1], movie: [11], 'tv&keywords=3020%2C219906': [2], 'movie&keywords=3020%2C219906': [], 'tv&keywords=3020%7C219906': [3], 'movie&keywords=3020%7C219906': [13] };
  const s = section(h, { name: 'network', feeds });
  s.button.click();
  const search = bodyOf(h, 'keywords').querySelector('.jellyseerr-menu-search');
  search.value = 'sheep';
  search.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => bodyOf(h, 'keywords').querySelectorAll('.actionSheetMenuItem').length === 2, 'keywords found');
  tickRow(h, 'keywords', 'sheep');
  // One ticked: the choice is shown (it can be made first) but idle, not in the accent.
  assert.equal(bodyOf(h, 'keywords').querySelector('.jellyseerr-menu-match').hasAttribute('data-idle'), true);
  search.value = 'sheep';
  search.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => [...bodyOf(h, 'keywords').querySelectorAll('.actionSheetItemText')].some(node => node.textContent === 'sheep farm'), 'more found');
  tickRow(h, 'keywords', 'sheep farm');
  assert.equal(String(s.shown()), '2');
  const choice = bodyOf(h, 'keywords').querySelector('.jellyseerr-menu-match');
  // Two ticked: the choice changes the list, so it is not idle (with one it was: see above).
  assert.equal(choice.hasAttribute('data-idle'), false);
  same([...choice.querySelectorAll('button')].map(button => [button.firstChild.textContent, button.getAttribute('aria-checked')]), [['all ticked', 'true'], ['any ticked', 'false']]);
  // (Each half holds its words again, bold and out of sight, so it is as wide chosen or not; a reader hears them once.)
  same([...choice.querySelectorAll('.jellyseerr-menu-match-reserve')].map(copy => [copy.textContent, copy.getAttribute('aria-hidden')]), [['all ticked', 'true'], ['any ticked', 'true']]);
  choice.querySelector('[data-match="any"]').click();
  assert.equal(String(s.shown()), '3,13');
  assert.equal(groupOf(h, 'keywords').textContent, 'Keywordssheep or sheep farm');
  // Matched by all, two say "and".
  const setLine = s.root.querySelector('.jellyseerr-filters-set');
  // ("or" goes with what follows it, which needs no "With" of its own.)
  same([...setLine.querySelectorAll('.jellyseerr-filters-token')].map(piece => piece.textContent), ['With sheep', 'or sheep farm']);
  // The run joined by "or" is one unit on the line.
  same([...setLine.children].map(piece => piece.className), ['jellyseerr-filters-run', 'jellyseerr-filters-clear']);
  // (Named as its list, for a reader moving by group.)
  same([setLine.firstElementChild.getAttribute('role'), setLine.firstElementChild.getAttribute('aria-label')], ['group', 'Keywords']);
  assert.equal(groupOf(h, 'keywords').textContent.endsWith('sheep or sheep farm'), true);
  same(plain(h.F.selectionOf('network')).match, { keywords: 'any' });
  assert.equal(choice.querySelector('[role="radiogroup"]').getAttribute('aria-label'), 'Keywords: Titles with');
  // Back to all: the default is not kept, and the line says "and" as it said "or".
  choice.querySelector('[data-match="all"]').click();
  assert.equal(String(s.shown()), '2');
  assert.equal(plain(h.F.selectionOf('network')).match, undefined);
  same([...setLine.querySelectorAll('.jellyseerr-filters-token')].map(piece => piece.textContent), ['With sheep', 'and sheep farm']);
  same([...setLine.children].map(piece => piece.className), ['jellyseerr-filters-run', 'jellyseerr-filters-clear']);
  // Genres and services have the choice too; a language or a rating has one rule.
  await until(() => bodyOf(h, 'genres').querySelector('.jellyseerr-menu-match'), 'genres');
  await until(() => bodyOf(h, 'services').querySelector('.jellyseerr-menu-match [data-match="any"][aria-checked="true"]'), 'services, any by default');
  await until(() => bodyOf(h, 'language').querySelector('.jellyseerr-menu-note'), 'languages');
  assert.equal(bodyOf(h, 'language').querySelector('.jellyseerr-menu-match'), null);
  h.document.querySelector('.dialogBackdrop').click();
  // A tag's page names its keyword in its own request: its keywords are matched by all, with no choice.
  const tag = h.F.createFiltersControl(h.document.createElement('div'), 'tag', 'feed', () => {}, undefined, undefined, ['keywords']);
  h.document.body.appendChild(tag);
  tag.click();
  assert.equal(bodyOf(h, 'keywords').querySelector('.jellyseerr-menu-match'), null);
  assert.equal(bodyOf(h, 'keywords').querySelector('.jellyseerr-menu-note').textContent, 'All of the keywords ticked.');
});

test('a Without list: none of what is ticked, said once at its start; a thing wanted and left out at once leaves the other list', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const h = setup(t, { lists: FILTER_LISTS, genres: { movie: [{ id: 36, name: 'Comedy' }, { id: 27, name: 'Horror' }, { id: 53, name: 'Thriller' }], tv: [{ id: 35, name: 'Comedy' }] } });
  const s = section(h, { name: 'network', feeds: { tv: [1], movie: [11] } });
  s.button.click();
  await until(() => bodyOf(h, 'withoutGenres').querySelectorAll('.actionSheetMenuItem').length === 3, 'the genres to leave out');
  tickRow(h, 'withoutGenres', 'Horror');
  tickRow(h, 'withoutGenres', 'Thriller');
  // On the row, "or" under its Without heading; on the page, "Not" once, then the names joined by "or", one run.
  assert.equal(groupOf(h, 'withoutGenres').textContent, 'Without genresHorror or Thriller');
  const setLine = s.root.querySelector('.jellyseerr-filters-set');
  same([...setLine.querySelectorAll('.jellyseerr-filters-token')].map(piece => piece.textContent), ['Not Horror', 'or Thriller']);
  same([setLine.firstElementChild.className, setLine.firstElementChild.getAttribute('aria-label')], ['jellyseerr-filters-run', 'Without genres']);
  // Horror wanted after all: ticked under Genres, it leaves Without genres (its row says so, its body is built anew).
  await until(() => bodyOf(h, 'genres').querySelectorAll('.actionSheetMenuItem').length === 3, 'the genres');
  // (Its row says where it is ticked, so ticking it here is not a silent move.)
  const horror = [...bodyOf(h, 'genres').querySelectorAll('.actionSheetMenuItem')].find(row => row.querySelector('.actionSheetItemText').textContent === 'Horror');
  assert.equal(horror.querySelector('.jellyseerr-menu-elsewhere').textContent, 'Ticked under Without genres');
  tickRow(h, 'genres', 'Horror');
  assert.equal(horror.querySelector('.jellyseerr-menu-elsewhere'), null);
  same(plain(h.F.selectionOf('network')).genres.map(genre => genre.name), ['Horror']);
  same(plain(h.F.selectionOf('network')).withoutGenres.map(genre => genre.name), ['Thriller']);
  assert.equal(groupOf(h, 'withoutGenres').textContent, 'Without genresThriller');
  await until(() => bodyOf(h, 'withoutGenres').querySelectorAll('.actionSheetMenuItem').length === 3, 'built anew');
  same([...bodyOf(h, 'withoutGenres').querySelectorAll('.actionSheetMenuItem[aria-checked="true"] .actionSheetItemText')].map(node => node.textContent), ['Thriller']);
  // And the last one out: the row says None again.
  tickRow(h, 'withoutGenres', 'Thriller');
  assert.equal(groupOf(h, 'withoutGenres').textContent, 'Without genresNone');
});

test('all / any chosen before anything is ticked is kept; the keys and a remote reach it and switch it', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const h = setup(t, { lists: FILTER_LISTS, genres: COMEDY });
  const feeds = { tv: [1], movie: [11], 'tv&keywords=3020%7C219906': [3], 'movie&keywords=3020%7C219906': [13] };
  const s = section(h, { name: 'network', feeds });
  s.button.click();
  const body = bodyOf(h, 'keywords');
  // Any first, then the keywords: they are asked for as any of them.
  body.querySelector('.jellyseerr-menu-match [data-match="any"]').click();
  same(plain(h.F.selectionOf('network')).match, { keywords: 'any' });
  const search = body.querySelector('.jellyseerr-menu-search');
  for (const name of ['sheep', 'sheep farm']) {
    search.value = 'sheep';
    search.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => [...body.querySelectorAll('.actionSheetItemText')].some(node => node.textContent === name && !node.closest('[aria-checked="true"]')), name);
    tickRow(h, 'keywords', name);
  }
  assert.equal(String(s.shown()), '3,13');
  // The keys: up from the search field reaches the choice in use (it sits with the keywords chosen); left switches
  // it (no wrapping round), left again is the way out to the group's row; down leaves it.
  const press = key => h.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  search.focus();
  let steps = 0;
  while (!h.document.activeElement.classList.contains('jellyseerr-menu-match-btn') && steps++ < 6) press('ArrowUp');
  assert.equal(h.document.activeElement.dataset.match, 'any');
  press('ArrowRight');
  assert.equal(h.document.activeElement.dataset.match, 'any', 'no half that way: it stays');
  press('ArrowLeft');
  assert.equal(h.document.activeElement.dataset.match, 'all');
  assert.equal(h.document.activeElement.getAttribute('aria-checked'), 'true');
  assert.equal(plain(h.F.selectionOf('network')).match, undefined);
  press('ArrowLeft');
  assert.equal(h.document.activeElement, groupOf(h, 'keywords'), 'out to the group row');
  // Unticked with the keys on it, a kept keyword hands them to the next one kept, and the last to the field.
  const kept = name => [...body.querySelectorAll('.jellyseerr-menu-tick[aria-checked="true"]')].find(row => row.textContent === name);
  kept('sheep').focus();
  kept('sheep').click();
  assert.equal(h.document.activeElement.textContent, 'sheep farm');
  h.document.activeElement.click();
  assert.equal(h.document.activeElement, search);
  assert.equal(body.querySelector('.jellyseerr-menu-match').hidden, true);
});

test('saved filters: the user\'s profiles first in the menu, saved under a name, applied by the page, deleted', { skip: !hasMenu && 'the menu module is not there yet' }, async t => {
  const h = setup(t, { lists: FILTER_LISTS, genres: COMEDY });
  // (The address reader, for what each profile sets.)
  h.load('jellyseerr/discovery/discovery-address.js');
  // The server's side, as the endpoints answer (Helpers/DiscoveryFilterProfiles.cs).
  const stored = [{ id: 'a1', name: 'Kids', filters: 'jeType=series&jeGenres=16/16:Animation,10751/10751:Family&jeAny=genres&jeScore=7..' }];
  const asked = [];
  h.window.ApiClient.ajax = async ({ type, url, data }) => {
    asked.push([type, url.replace('http://jellyfin.test', '')]);
    if (type === 'GET') return { max: 30, profiles: structuredClone(stored) };
    if (type === 'POST') { const body = JSON.parse(data); const one = { id: 'b2', ...body }; stored.push(one); return { profile: one }; }
    if (type === 'DELETE') { stored.splice(stored.findIndex(p => url.endsWith(p.id)), 1); return {}; }
  };
  let now = 'jeScore=7..';
  const applied = [];
  const host = { read: () => now, apply: text => { applied.push(text); now = text; } };
  const header = h.document.createElement('div');
  h.document.body.appendChild(header);
  const button = h.F.createFiltersControl(header, 'network', 'feed', () => {}, undefined, undefined, [], host);
  h.document.body.appendChild(button);
  await until(() => asked.length === 1, 'asked once for the visit');
  // (Its answer is kept once its callbacks have run: a turn of the event loop.)
  await new Promise(resolve => setTimeout(resolve, 0));
  button.click();
  const groups = () => [...menuOf(h).querySelectorAll('.jellyseerr-menu-group')];
  assert.equal(groups()[0].textContent, 'Saved filters1 saved', 'first, saying how many there are');
  const body = bodyOf(h, 'profiles');
  await until(() => body.querySelector('.jellyseerr-menu-profile'), 'the profiles');
  same([...body.querySelectorAll('.jellyseerr-menu-profile .actionSheetItemText')].map(row => row.textContent), ['Kids']);
  // Under its name, what it sets, in the page's words.
  // (What tells sets apart first; a line breaks only between parts.)
  same([...body.querySelectorAll('.jellyseerr-menu-profile-says .jellyseerr-menu-profile-part')].map(part => part.textContent), ['Animation or Family ·', 'Score from 7 ·', 'Series']);
  // What is set now, under a name.
  const field = body.querySelector('.jellyseerr-menu-profile-form input');
  const save = body.querySelector('.jellyseerr-menu-profile-save');
  // (Save is there to press once there is a name.)
  assert.equal(save.disabled, true);
  field.value = '  ';
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(save.disabled, true, 'not for spaces');
  field.value = 'Top rated';
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(save.disabled, false);
  save.click();
  await until(() => body.querySelectorAll('.jellyseerr-menu-profile').length === 2, 'saved');
  same(stored[1], { id: 'b2', name: 'Top rated', filters: 'jeScore=7..' });
  assert.equal(groups()[0].textContent, 'Saved filtersTop rated', 'the one that is set now is named');
  assert.match(body.querySelector('.jellyseerr-menu-note').textContent, /Saved as “Top rated”/);
  // Deleting one (a bin, not the page's cross) asks the server, and it goes; the keys go to the one before, and it is said.
  const last = body.querySelector('.jellyseerr-menu-profile-row:last-child .jellyseerr-menu-profile-delete');
  assert.equal(last.querySelector('.material-icons').classList.contains('delete_outline'), true);
  assert.equal(last.getAttribute('aria-label'), 'Delete Top rated');
  last.focus();
  last.click();
  await until(() => body.querySelectorAll('.jellyseerr-menu-profile').length === 1, 'deleted');
  assert.deepEqual(asked.at(-1), ['DELETE', '/JellyfinEnhanced/user-settings/user-a/discovery-filter-profiles/b2']);
  assert.equal(h.document.activeElement, body.querySelector('.jellyseerr-menu-profile-delete'));
  const status = body.querySelector('.jellyseerr-menu-note');
  assert.match(status.textContent, /Deleted “Top rated”/);
  // (The group's row counts what is left: none of them is what is set now.)
  assert.equal(groups()[0].textContent, 'Saved filters1 saved');
  // Undo saves it again.
  status.querySelector('.jellyseerr-menu-profile-undo').click();
  await until(() => body.querySelectorAll('.jellyseerr-menu-profile').length === 2, 'restored');
  same(stored.at(-1), { id: 'b2', name: 'Top rated', filters: 'jeScore=7..' });
  assert.match(status.textContent, /Restored “Top rated”/);
  assert.equal(groups()[0].textContent, 'Saved filtersTop rated');
  assert.equal(body.querySelector('.jellyseerr-menu-profile[aria-current="true"] .actionSheetItemText').textContent, 'Top rated');
  // The keys: a profile's delete is beside its row, not a stop on the way down (right reaches it, left goes back).
  const press = key => h.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const [kids, top] = body.querySelectorAll('.jellyseerr-menu-profile');
  kids.focus();
  press('ArrowDown');
  assert.equal(h.document.activeElement, top, 'down goes to the next profile');
  press('ArrowRight');
  assert.equal(h.document.activeElement, top.parentElement.querySelector('.jellyseerr-menu-profile-delete'));
  press('ArrowLeft');
  assert.equal(h.document.activeElement, top);
  top.parentElement.querySelector('.jellyseerr-menu-profile-delete').click();
  await until(() => body.querySelectorAll('.jellyseerr-menu-profile').length === 1, 'deleted again');
  // What is set the same as a saved set, written in another order (a set saved by hand, or by an earlier version): known as it.
  const before = now;
  now = 'jeScore=7..&jeAny=genres&jeGenres=16/16:Animation,10751/10751:Family&jeType=series';
  h.document.querySelector('.dialogBackdrop').click();
  button.click();
  assert.equal(groups()[0].textContent, 'Saved filtersKids');
  await until(() => bodyOf(h, 'profiles').querySelector('.jellyseerr-menu-profile[aria-current="true"]'), 'ticked as the one in use');
  now = before;
  h.document.querySelector('.dialogBackdrop').click();
  button.click();
  // Choosing one: the page applies it and the menu is done.
  await until(() => bodyOf(h, 'profiles').querySelector('.jellyseerr-menu-profile'), 'the profiles again');
  bodyOf(h, 'profiles').querySelector('.jellyseerr-menu-profile').click();
  same(applied, ['jeType=series&jeGenres=16/16:Animation,10751/10751:Family&jeAny=genres&jeScore=7..']);
  assert.equal(menuOf(h), null);
  // Nothing set: nothing to save.
  now = '';
  const askedBefore = asked.length;
  button.click();
  // (The visit's list was kept as the server has it after the saves and deletes: the count is said at once, unasked.)
  assert.equal(groups()[0].textContent, 'Saved filters1 saved');
  const again = bodyOf(h, 'profiles');
  await until(() => again.querySelector('.jellyseerr-menu-profile'), 'the profiles again');
  assert.equal(again.querySelector('.jellyseerr-menu-profile-save').disabled, true);
  assert.equal(asked.length, askedBefore, 'not asked again');
});

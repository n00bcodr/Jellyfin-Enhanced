import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { repositoryRoot } from './discovery.mjs';
import { jsRoot } from './harness.mjs';
import { manifestModules, rawGroups, resolveGroups } from './eval-reads.mjs';
import { bootLoader } from './loader-harness.mjs';
import { schema } from '../contracts/fixtures.mjs';

// Measures what a cold Home load downloads and runs under the component-group loader (js/plugin.js), for
// scripts/bundle-budgets.json. The groups come from the real loader rules: plugin.js boots in
// jsdom with the real manifest and groups file and a fixture config, and the groups it asks for before
// JE.initialized are the cold load. Sizes are of the module text the bundle route serves, which is each module's
// minified twin (min/js/<path>, canopy K1); the bundle's per-module wrapper is not counted.

export const budgetPath = resolve(repositoryRoot, 'scripts/bundle-budgets.json');
const minRoot = resolve(jsRoot, '../min/js');

/**
 * The plugin's stock defaults: every literal boolean or string a fresh PluginConfiguration has (property
 * initializers first, then the constructor's assignments, which run after them).
 * @returns {Object<string, boolean|string>}
 */
export function pluginDefaults() {
  const source = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/PluginConfiguration.cs'), 'utf8');
  const literal = text => (text === 'true' ? true : text === 'false' ? false : JSON.parse(text));
  const defaults = {};
  for (const [, name, value] of source.matchAll(/public\s+\w+\??\s+([A-Z]\w*)\s*\{\s*get;\s*set;\s*\}\s*=\s*(true|false|"[^"\\]*")\s*;/g)) defaults[name] = literal(value);
  for (const [, name, value] of source.matchAll(/^\s+([A-Z]\w*)\s*=\s*(true|false|"[^"\\]*")\s*;/gm)) defaults[name] = literal(value);
  return defaults;
}

/** The keys of a bootstrap contract type whose value is a plain boolean (contracts/bootstrap.schema.json). */
const booleanKeys = type => Object.entries(schema.$defs[type].properties).filter(([, rule]) => rule.type === 'boolean').map(([key]) => key);
const PUBLIC_SWITCHES = booleanKeys('BootstrapPublicConfig');
const SETTING_SWITCHES = booleanKeys('BootstrapSettings').filter(key => key !== 'IsAdmin');
const pick = (keys, values) => Object.fromEntries(keys.filter(key => typeof values[key] === 'boolean').map(key => [key, values[key]]));

/**
 * The public config the bootstrap would carry for a plugin configuration: the switches the contract sends (the
 * endpoint passes them through by name), plus the derived ones the loader rules read. TagStyleWebActive also holds
 * when the admin set a style override; with stock settings there is none.
 * @param {object} config
 * @returns {object}
 */
function publicConfigFrom(config) {
  return { ...pick(PUBLIC_SWITCHES, config), TagStyleWebActive: !!config.TagStylesEnabled && ['web', 'both'].includes(config.TagStyleTarget) && !!config.TagStylesAllowUserPreset,
    MaintainerrActionsAvailable: false, RemovalRequestsAvailable: false };
}

/**
 * The settings document the bootstrap would carry for a user: the server resolves a switch the user never saved to
 * the administrator's default of the same name (Shared/Settings/SettingsDefaults.cs), then come the user's own.
 * @param {object} config The plugin configuration.
 * @param {object} saved The user's saved switches.
 */
const settingsFrom = (config, saved) => ({ ...pick(SETTING_SWITCHES, config), ...pick(SETTING_SWITCHES, saved) });

// The performance-review lab's setup script: the switches it turns on (admin config), and the
// signed-in user's own settings, plus every poster tag type on and administrator rights.
const LAB_CONFIG_ON = `ActiveStreamsEnabled ActiveStreamsAllUsers ActivityFeedEnabled ActivityFeedUseNativeTab AgeRatingTagsEnabled AwardsTagsEnabled
BookmarksEnabled BookmarksUseNativeTab CalendarPageEnabled CalendarHighlightFavorites CalendarHighlightWatchedSeries CalendarUseNativeTab
CatchUpEnabled CatchUpUseNativeTab ColoredActivityIconsEnabled ColoredRatingsEnabled CustomTagsEnabled DownloadsPageEnabled DownloadsPagePollingEnabled
DownloadsUseNativeTab ElsewhereEnabled GenreTagsEnabled HiddenContentEnabled HiddenContentUseNativeTab JellyseerrAvailablePosterLinksToJellyfin
LanguageTagsEnabled LanguageTagsShowAudio LanguageTagsShowSubtitles LeavingSoonPageEnabled LeavingSoonPageUseNativeTab LetterboxdEnabled LogoTagsEnabled
MetadataIconsEnabled NativePosterTagsEnabled PeopleTagsEnabled PluginIconsEnabled QualityTagsEnabled QualityTagsAudioLanguageFromUser RandomButtonEnabled
RatingTagsEnabled RatingTagsColorByScore RecommendationsPageEnabled RecommendationsUseNativeTab RemoveContinueWatchingEnabled ShowAspectRatioTag
ShowAudioInfoTag ShowAwards ShowDynamicRangeTag ShowEditionTag ShowFileSizes ShowFrameRateTag ShowLowQualitySourceTag ShowReleaseDates ShowResolutionTag
ShowReviews ShowRuntimeTag ShowSourceTag ShowSpecialFormatTag ShowUserRatingOnPosters ShowUserReviews ShowVersionsTag ShowVideoCodecTag ShowWatchProgress
SpoilerBlurEnabled SpoilerBlurArtwork StatusTagsEnabled StatusTagsDirectPlay StatusTagsJustAdded StatusTagsLeaving StatusTagsMilestones StatusTagsNewRelease
StatusTagsScenes StatusTagsSeriesStatus StatusTagsTrending TagStylesEnabled TagStylesAllowUserPreset TagsHideOnHover ThemeSelectorEnabled
JellyseerrEnabled JellyseerrShowRecommended JellyseerrShowSimilar JellyseerrShowSearchResults JellyseerrShowIssueIndicator`.split(/\s+/);
const LAB_USER_ON = `AgeRatingTagsEnabled AwardsTagsEnabled CustomTagsEnabled LanguageTagsShowSubtitles LogoTagsEnabled RatingTagsColorByScore
RemoveContinueWatchingEnabled StatusTagsDirectPlay StatusTagsEnabled StatusTagsLeaving StatusTagsScenes StatusTagsSeriesStatus TagsHideOnHover`.split(/\s+/);
/** The nine poster tag types (group-rules.ts POSTER_TAG_SETTINGS), as the settings document spells them. */
export const POSTER_TAG_TYPES = ['QualityTagsEnabled', 'GenreTagsEnabled', 'RatingTagsEnabled', 'AgeRatingTagsEnabled', 'StatusTagsEnabled',
  'AwardsTagsEnabled', 'CustomTagsEnabled', 'LanguageTagsEnabled', 'LogoTagsEnabled'];
const on = keys => Object.fromEntries(keys.map(key => [key, true]));

/** The measured scenarios: a cold load of Home with this public config and settings document. */
export function scenarios() {
  const defaults = pluginDefaults();
  const lab = { ...defaults, ...on(LAB_CONFIG_ON) };
  return {
    allFeaturesOn: { config: publicConfigFrom(lab), admin: true,
      settings: settingsFrom(lab, { ...on(LAB_USER_ON), ...on(POSTER_TAG_TYPES), PeopleTagsEnabled: true }) },
    defaults: { config: publicConfigFrom(defaults), admin: false, settings: settingsFrom(defaults, {}) },
    tagsOnly: { config: publicConfigFrom(defaults), admin: false, settings: settingsFrom(defaults, on(POSTER_TAG_TYPES)) }
  };
}

const fileBytes = new Map();
/** A module's served bytes: its minified twin when the build made one, as the bundle route reads it. */
const bytesOf = path => {
  if (!fileBytes.has(path)) fileBytes.set(path, readFileSync(existsSync(resolve(minRoot, path)) ? resolve(minRoot, path) : resolve(jsRoot, path)));
  return fileBytes.get(path);
};

/**
 * Sizes of a list of modules in run order: count, raw bytes (sum of the served files) and gzip bytes (level 9 of
 * the files concatenated in that order).
 * @param {string[]} modules
 */
export function sizeOf(modules) {
  const buffers = modules.map(bytesOf);
  return { modules: modules.length, rawBytes: buffers.reduce((sum, buffer) => sum + buffer.length, 0), gzipBytes: gzipSync(Buffer.concat(buffers), { level: 9 }).length };
}

/** Every group's modules and raw bytes, "core" first. */
export function groupSizes() {
  return resolveGroups(manifestModules(), rawGroups()).map(group => ({ id: group.id, modules: group.scripts.length, rawBytes: sizeOf(group.scripts).rawBytes }));
}

/**
 * Boots the real loader for one scenario and returns the groups a cold Home load runs, with their sizes.
 * @param {{ after: (fn: Function) => void }} t - node:test context (or anything with `after`).
 * @param {{ config: object, settings: object, admin: boolean }} scenario
 */
export async function measureScenario(t, scenario) {
  const manifest = manifestModules();
  const groups = rawGroups();
  const boot = bootLoader(t, { manifest, groups, publicConfig: scenario.config, userSettings: scenario.settings, admin: scenario.admin,
    url: 'http://jellyfin.test/web/index.html#/home.html' });
  await boot.booted();
  const asked = boot.requests.flatMap(request => request.ids || ['core']);
  const order = resolveGroups(manifest, groups);
  const loaded = order.filter(group => asked.includes(group.id));
  return { groups: loaded.map(group => group.id), requests: boot.requests.length, ...sizeOf(loaded.flatMap(group => group.scripts)) };
}

/** The whole manifest's size (what the single bundle ran on every page). */
export const manifestSize = () => sizeOf(manifestModules());

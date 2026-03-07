/**
 * @file E2E-style security tests for CodeQL fix verification.
 *
 * Validates that:
 *  - JE.escapeHtml correctly neutralises XSS payloads (CWE-79)
 *  - No tainted format strings remain in console.error calls (CWE-134)
 *  - GitHub Actions workflows have explicit permissions (CWE-275)
 *  - markdownToHtml link regex rejects dangerous URI schemes
 *  - Collection modal escapes API-sourced values
 *  - All escapeHtml definitions delegate to JE.escapeHtml
 *
 * Run: node tests/security-fixes.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'Jellyfin.Plugin.JellyfinEnhanced', 'js');
const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${message}`);
    } else {
        failed++;
        console.log(`  \x1b[31m✗\x1b[0m ${message}`);
    }
}

// ---------------------------------------------------------------------------
// 1. JE.escapeHtml correctness
// ---------------------------------------------------------------------------
console.log('\n--- JE.escapeHtml correctness ---');

// Simulate JE.escapeHtml from plugin.js
const escapeHtml = (str) => {
    if (typeof str !== 'string') return String(str ?? '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
};

assert(escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;',
    'Escapes script tags');

assert(escapeHtml('"onmouseover="alert(1)"') === '&quot;onmouseover=&quot;alert(1)&quot;',
    'Escapes double quotes in attribute injection');

assert(escapeHtml("'onclick='alert(1)'") === "&#039;onclick=&#039;alert(1)&#039;",
    'Escapes single quotes');

assert(escapeHtml('a & b < c > d') === 'a &amp; b &lt; c &gt; d',
    'Escapes ampersands and angle brackets');

assert(escapeHtml('') === '', 'Empty string returns empty');
assert(escapeHtml(null) === '', 'null returns empty string');
assert(escapeHtml(undefined) === '', 'undefined returns empty string');
assert(escapeHtml(42) === '42', 'Numbers are coerced to string');
assert(escapeHtml('safe text') === 'safe text', 'Safe text passes through unchanged');

// Nested/recursive attack
assert(escapeHtml('&lt;script&gt;') === '&amp;lt;script&amp;gt;',
    'Already-escaped text is double-escaped (safe)');

// ---------------------------------------------------------------------------
// 2. No tainted format strings in changed files (CWE-134)
// ---------------------------------------------------------------------------
console.log('\n--- Tainted format string checks (CWE-134) ---');

const featuresJs = fs.readFileSync(path.join(JS_DIR, 'enhanced', 'features.js'), 'utf8');
const apiJs = fs.readFileSync(path.join(JS_DIR, 'jellyseerr', 'api.js'), 'utf8');

// Verify the three features.js console.error calls use %s format
const watchProgressMatch = featuresJs.match(/console\.error\('.*Error fetching watch progress for ID %s:'/);
assert(!!watchProgressMatch, 'features.js: watch progress error uses %s format specifier');

const fileSizeMatch = featuresJs.match(/console\.error\('.*Error fetching item size for ID %s:'/);
assert(!!fileSizeMatch, 'features.js: file size error uses %s format specifier');

const audioLangMatch = featuresJs.match(/console\.error\('.*Error fetching audio languages for %s:'/);
assert(!!audioLangMatch, 'features.js: audio languages error uses %s format specifier');

// Verify api.js search error uses %s format
const searchMatch = apiJs.match(/console\.error\('%s Search failed for query "%s":'/);
assert(!!searchMatch, 'api.js: search error uses %s format specifiers');

// Verify none of these lines use template literals with external data
const taintedPatternFeatures = /console\.error\(`[^`]*\$\{itemId\}[^`]*`/;
assert(!taintedPatternFeatures.test(featuresJs),
    'features.js: no template literal console.error with ${itemId}');

const taintedPatternApi = /console\.error\(`[^`]*\$\{query\}[^`]*`/;
assert(!taintedPatternApi.test(apiJs),
    'api.js: no template literal console.error with ${query}');

// ---------------------------------------------------------------------------
// 3. GitHub Actions workflow permissions (CWE-275)
// ---------------------------------------------------------------------------
console.log('\n--- Workflow permissions checks (CWE-275) ---');

const workflows = ['stale.yml', 'translation_validation.yml', 'check-unused-translations.yml'];
for (const wf of workflows) {
    const content = fs.readFileSync(path.join(WORKFLOW_DIR, wf), 'utf8');
    assert(content.includes('permissions:'), `${wf}: has explicit permissions block`);
    assert(content.includes('contents: read'), `${wf}: has contents: read`);
}

const staleYml = fs.readFileSync(path.join(WORKFLOW_DIR, 'stale.yml'), 'utf8');
assert(staleYml.includes('issues: write'), 'stale.yml: has issues: write');
assert(staleYml.includes('pull-requests: write'), 'stale.yml: has pull-requests: write');

// ---------------------------------------------------------------------------
// 4. XSS through DOM checks (CWE-79)
// ---------------------------------------------------------------------------
console.log('\n--- XSS through DOM checks (CWE-79) ---');

const modalJs = fs.readFileSync(path.join(JS_DIR, 'jellyseerr', 'modal.js'), 'utf8');

// Modal should use textContent for title/subtitle (not innerHTML)
assert(modalJs.includes('titleEl.textContent = title'), 'modal.js: title set via textContent');
assert(modalJs.includes('subtitleEl.textContent = subtitle'), 'modal.js: subtitle set via textContent');
assert(modalJs.includes('cancelBtn.textContent'), 'modal.js: cancel button uses textContent');
assert(modalJs.includes('primaryBtn.textContent'), 'modal.js: primary button uses textContent');

// No dead safe* variables should remain
assert(!modalJs.includes('safeTitle'), 'modal.js: no dead safeTitle variable');
assert(!modalJs.includes('safeSubtitle'), 'modal.js: no dead safeSubtitle variable');
assert(!modalJs.includes('safeCancelLabel'), 'modal.js: no dead safeCancelLabel variable');
assert(!modalJs.includes('safeButtonLabel'), 'modal.js: no dead safeButtonLabel variable');

// UI.js should escape dynamic values
const uiJs = fs.readFileSync(path.join(JS_DIR, 'enhanced', 'ui.js'), 'utf8');
assert(uiJs.includes('escapeHtml(JE.pluginVersion') || uiJs.includes("escapeHtml(JE.t('panel_version'"),
    'ui.js: plugin version is escaped in panel');
assert(uiJs.includes("escapeHtml(JE.state.activeShortcuts[action.Name]") || uiJs.includes("escapeHtml(JE.state.activeShortcuts[action]"),
    'ui.js: shortcut keys are escaped');
assert(uiJs.includes('escapeHtml(logoUrl)'), 'ui.js: logo URL is escaped');

// ---------------------------------------------------------------------------
// 5. markdownToHtml link safety
// ---------------------------------------------------------------------------
console.log('\n--- markdownToHtml link safety ---');

// The regex should only match https?:// URLs
const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

// Safe links should match
assert('[click](https://example.com)'.match(linkRegex) !== null,
    'markdownToHtml regex matches https:// links');
assert('[click](http://example.com)'.match(linkRegex) !== null,
    'markdownToHtml regex matches http:// links');

// Dangerous schemes should NOT match
assert('[click](javascript:alert(1))'.match(linkRegex) === null,
    'markdownToHtml regex rejects javascript: URLs');
assert('[click](data:text/html,<script>alert(1)</script>)'.match(linkRegex) === null,
    'markdownToHtml regex rejects data: URLs');
assert('[click](vbscript:alert(1))'.match(linkRegex) === null,
    'markdownToHtml regex rejects vbscript: URLs');

// Verify the actual file uses the safe pattern
assert(uiJs.includes('(https?:\\/\\/[^)]+)'), 'ui.js: markdownToHtml uses https-only link regex');

// markdownToHtml must escape raw HTML before applying regex transforms
assert(uiJs.includes('escapeHtml(text)'), 'ui.js: markdownToHtml escapes input before regex transforms');
assert(uiJs.includes('&gt;\\s*\\[!'), 'ui.js: blockquote regex matches &gt; (escaped >)');

// Simulate the full pipeline: raw HTML in markdown should be neutralised
const simulatedEscape = escapeHtml('<img src=x onerror=alert(1)>');
assert(!simulatedEscape.includes('<img'), 'markdownToHtml pipeline: <img> tag is escaped');
assert(simulatedEscape.includes('&lt;img'), 'markdownToHtml pipeline: <img> becomes &lt;img');

// Markdown syntax should still work after escaping (these chars are not HTML metacharacters)
assert(escapeHtml('## Heading') === '## Heading', 'markdownToHtml pipeline: ## passes through escapeHtml');
assert(escapeHtml('**bold**') === '**bold**', 'markdownToHtml pipeline: **bold** passes through escapeHtml');
assert(escapeHtml('`code`') === '`code`', 'markdownToHtml pipeline: backtick code passes through escapeHtml');

// ---------------------------------------------------------------------------
// 6. Collection modal escapes API data
// ---------------------------------------------------------------------------
console.log('\n--- Collection modal API data escaping ---');

const jellyseerrUi = fs.readFileSync(path.join(JS_DIR, 'jellyseerr', 'ui.js'), 'utf8');

assert(jellyseerrUi.includes('JE.escapeHtml(movie.title)'),
    'jellyseerr/ui.js: movie.title is escaped in collection modal');
assert(jellyseerrUi.includes('JE.escapeHtml(movie.id)'),
    'jellyseerr/ui.js: movie.id is escaped in collection modal');
assert(jellyseerrUi.includes('JE.escapeHtml(poster)'),
    'jellyseerr/ui.js: poster URL is escaped in collection modal');

// ---------------------------------------------------------------------------
// 6b. Season request modal escapes API data
// ---------------------------------------------------------------------------
console.log('\n--- Season request modal API data escaping ---');

assert(jellyseerrUi.includes('JE.escapeHtml(season.name'),
    'jellyseerr/ui.js: season.name is escaped in season modal');
assert(jellyseerrUi.includes('JE.escapeHtml(season.airDate'),
    'jellyseerr/ui.js: season.airDate is escaped in season modal');
assert(jellyseerrUi.includes('JE.escapeHtml(season.episodeCount'),
    'jellyseerr/ui.js: season.episodeCount is escaped in season modal');
assert(jellyseerrUi.includes('JE.escapeHtml(seasonNumber)'),
    'jellyseerr/ui.js: seasonNumber is escaped in data attribute');

// ---------------------------------------------------------------------------
// 7. escapeHtml consolidation — no local definitions remain
// ---------------------------------------------------------------------------
console.log('\n--- escapeHtml consolidation ---');

const filesToCheck = [
    'enhanced/ui.js', 'jellyseerr/modal.js', 'jellyseerr/issue-reporter.js',
    'arr/requests-page.js', 'arr/calendar-page.js', 'enhanced/bookmarks.js',
    'enhanced/bookmarks-library.js', 'elsewhere/reviews.js', 'jellyseerr/more-info-modal.js'
];

for (const file of filesToCheck) {
    const content = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    const localDefs = (content.match(/function escapeHtml/g) || []).length;
    assert(localDefs === 0, `${file}: no local function escapeHtml definition`);
}

// Verify plugin.js has the shared definition
const pluginJs = fs.readFileSync(path.join(JS_DIR, 'plugin.js'), 'utf8');
assert(pluginJs.includes('escapeHtml:'), 'plugin.js: exports JE.escapeHtml');
assert(pluginJs.includes('@param {string} str'), 'plugin.js: escapeHtml has JSDoc @param');
assert(pluginJs.includes('@returns {string}'), 'plugin.js: escapeHtml has JSDoc @returns');

// ---------------------------------------------------------------------------
// 8. Release notes escaping
// ---------------------------------------------------------------------------
console.log('\n--- Release notes escaping ---');

assert(uiJs.includes('escapeHtml(release.tag_name)'), 'ui.js: release tag_name is escaped');
assert(uiJs.includes('escapeHtml(release.html_url)'), 'ui.js: release html_url is escaped');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(50));

if (failed > 0) {
    process.exit(1);
}

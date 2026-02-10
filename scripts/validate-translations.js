#!/usr/bin/env node

/**
 * Translation Validation and Helper Script
 *
 * This script helps manage translations for Jellyfin Enhanced by:
 * - Validating all translation files against the base (en.json)
 * - Detecting missing keys in translations
 * - Finding unused translation keys not referenced in code
 * - Checking for placeholder mismatches
 * - Generating translation templates for new languages
 *
 * Usage:
 *   node scripts/validate-translations.js [command] [options]
 *
 * Commands:
 *   validate [lang]   - Validate one or all translation files
 *   find-unused       - Find translation keys not used in code
 *   create <lang>     - Create a new translation file template
 *   stats             - Show translation completion statistics
 *   help              - Show this help message
 */

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '../Jellyfin.Plugin.JellyfinEnhanced/js/locales');
const JS_DIR = path.join(__dirname, '../Jellyfin.Plugin.JellyfinEnhanced/js');
const BASE_LANG = 'en';

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bold: '\x1b[1m'
};

function log(message, color = 'reset') {
    console.log(colors[color] + message + colors.reset);
}

function logError(message) {
    log(`✗ ${message}`, 'red');
}

function logSuccess(message) {
    log(`✓ ${message}`, 'green');
}

function logWarning(message) {
    log(`⚠ ${message}`, 'yellow');
}

function logInfo(message) {
    log(`ℹ ${message}`, 'cyan');
}

/**
 * Load a translation file
 */
function loadTranslation(lang) {
    const filePath = path.join(LOCALES_DIR, `${lang}.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logError(`Failed to parse ${lang}.json: ${error.message}`);
        return null;
    }
}

/**
 * Get all available translation languages
 */
function getAvailableLanguages() {
    if (!fs.existsSync(LOCALES_DIR)) {
        return [];
    }
    return fs.readdirSync(LOCALES_DIR)
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''))
        .sort();
}

/**
 * Extract placeholders from a translation string
 */
function extractPlaceholders(text) {
    const matches = text.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g);
    return matches ? [...new Set(matches)].sort() : [];
}

/**
 * Validate a single translation file against base
 */
function validateTranslation(lang, verbose = false) {
    if (lang === BASE_LANG) {
        logInfo(`Skipping validation of base language (${BASE_LANG})`);
        return { valid: true, errors: [], warnings: [] };
    }

    const baseTranslation = loadTranslation(BASE_LANG);
    const translation = loadTranslation(lang);

    if (!baseTranslation) {
        logError(`Base translation file (${BASE_LANG}.json) not found!`);
        return { valid: false, errors: ['Base file not found'], warnings: [] };
    }

    if (!translation) {
        logError(`Translation file ${lang}.json not found!`);
        return { valid: false, errors: ['Translation file not found'], warnings: [] };
    }

    const errors = [];
    const warnings = [];
    const baseKeys = Object.keys(baseTranslation).sort();
    const translationKeys = Object.keys(translation).sort();

    // Check for missing keys
    const missingKeys = baseKeys.filter(key => !translationKeys.includes(key));
    if (missingKeys.length > 0) {
        errors.push(`Missing ${missingKeys.length} key(s):`);
        missingKeys.forEach(key => {
            errors.push(`  - ${key}`);
        });
    }

    // Check for extra keys
    const extraKeys = translationKeys.filter(key => !baseKeys.includes(key));
    if (extraKeys.length > 0) {
        warnings.push(`Extra ${extraKeys.length} key(s) not in base translation:`);
        extraKeys.forEach(key => {
            warnings.push(`  - ${key}`);
        });
    }

    // Check for placeholder mismatches
    baseKeys.forEach(key => {
        if (!translation[key]) return;

        const basePlaceholders = extractPlaceholders(baseTranslation[key]);
        const translationPlaceholders = extractPlaceholders(translation[key]);

        if (basePlaceholders.length > 0) {
            const missingPlaceholders = basePlaceholders.filter(
                p => !translationPlaceholders.includes(p)
            );
            const extraPlaceholders = translationPlaceholders.filter(
                p => !basePlaceholders.includes(p)
            );

            if (missingPlaceholders.length > 0) {
                errors.push(`Key "${key}" missing placeholders: ${missingPlaceholders.join(', ')}`);
            }
            if (extraPlaceholders.length > 0) {
                warnings.push(`Key "${key}" has extra placeholders: ${extraPlaceholders.join(', ')}`);
            }
        }
    });

    // Check for empty translations
    translationKeys.forEach(key => {
        if (!translation[key] || translation[key].trim() === '') {
            warnings.push(`Key "${key}" has empty translation`);
        }
    });

    const valid = errors.length === 0;

    if (verbose || !valid || warnings.length > 0) {
        console.log();
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
        log(`Validation Results: ${lang}.json`, 'bold');
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');

        if (valid && warnings.length === 0) {
            logSuccess(`All checks passed! (${translationKeys.length} keys)`);
        } else {
            if (errors.length > 0) {
                logError(`Found ${errors.length} error(s):`);
                errors.forEach(err => console.log(colors.red + err + colors.reset));
            }
            if (warnings.length > 0) {
                logWarning(`Found ${warnings.length} warning(s):`);
                warnings.forEach(warn => console.log(colors.yellow + warn + colors.reset));
            }
        }

        const completion = Math.round((translationKeys.length / baseKeys.length) * 100);
        logInfo(`Completion: ${completion}% (${translationKeys.length}/${baseKeys.length} keys)`);
    }

    return { valid, errors, warnings };
}

/**
 * Find translation keys that are not used in the codebase
 */
function findUnusedKeys() {
    const baseTranslation = loadTranslation(BASE_LANG);
    if (!baseTranslation) {
        logError('Base translation file not found!');
        return;
    }

    const allKeys = Object.keys(baseTranslation);
    const usedKeys = new Set();

    // Recursively search for translation key usage in JavaScript files
    function searchDirectory(dir) {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory() && file !== 'locales' && file !== 'node_modules') {
                searchDirectory(filePath);
            } else if (file.endsWith('.js')) {
                const content = fs.readFileSync(filePath, 'utf8');

                const tMatches = content.matchAll(/(?:JE|window\.JellyfinEnhanced)\.t\s*(?:\?\.)?\s*\(\s*['"]([^'"]+)['"]/g);
                for (const match of tMatches) {
                    usedKeys.add(match[1]);
                }

                // Match shortcut_ keys used in shortcuts configuration and comparisons
                // e.g., activeShortcuts.OpenSearch, combo === activeShortcuts.GoToHome
                const shortcutMatches = content.matchAll(/activeShortcuts\.([A-Z][a-zA-Z]+)/g);
                for (const match of shortcutMatches) {
                    usedKeys.add(`shortcut_${match[1]}`);
                }

                // Match feature_ and status_ keys used in dynamic translation patterns
                // e.g., JE.t('feature_' + name) or JE.t(`feature_${name}`)
                // Also catch literal strings like 'feature_auto_pause', 'status_enabled'
                const dynamicMatches = content.matchAll(/['"`]((?:feature_|status_|jellyseerr_|elsewhere_)[a-z_]+)['"`]/g);
                for (const match of dynamicMatches) {
                    usedKeys.add(match[1]);
                }

                // Match template literal patterns: `${prefix}_${variable}`
                // This catches cases where keys are built dynamically
                const templateMatches = content.matchAll(/JE\.t\s*\(\s*`([^`]*)\$\{[^}]+\}([^`]*)`/g);
                for (const match of templateMatches) {
                    // Mark keys with dynamic parts as used if they match known patterns
                    const prefix = match[1];
                    if (prefix.match(/^(feature|status|jellyseerr|elsewhere|shortcut)_?$/)) {
                        // Find all keys in translations that start with this prefix
                        allKeys.forEach(key => {
                            if (key.startsWith(prefix)) {
                                usedKeys.add(key);
                            }
                        });
                    }
                }

                // Match keys passed as function parameters
                // e.g., addSettingToggleListener('id', 'setting', 'translation_key')
                const functionParamMatches = content.matchAll(/addSettingToggleListener\s*\([^,]+,\s*[^,]+,\s*['"]([^'"]+)['"]/g);
                for (const match of functionParamMatches) {
                    usedKeys.add(match[1]);
                }

                // Match title/tooltip attributes that use translation keys
                // e.g., title = JE.t('key') or .title = JE.t('key')
                const titleMatches = content.matchAll(/\.title\s*=\s*JE\.t\s*(?:\?\.)?\s*\(\s*['"]([^'"]+)['"]/g);
                for (const match of titleMatches) {
                    usedKeys.add(match[1]);
                }

                // Match textContent assignments
                const textContentMatches = content.matchAll(/\.textContent\s*=\s*JE\.t\s*(?:\?\.)?\s*\(\s*['"]([^'"]+)['"]/g);
                for (const match of textContentMatches) {
                    usedKeys.add(match[1]);
                }
            }
        });
    }

    searchDirectory(JS_DIR);

    const unusedKeys = allKeys.filter(key => !usedKeys.has(key));

    console.log();
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
    log(`Translation Usage Analysis`, 'bold');
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
    logInfo(`Total translation keys: ${allKeys.length}`);
    logSuccess(`Used in code: ${usedKeys.size}`);

    if (unusedKeys.length > 0) {
        logWarning(`Potentially unused keys: ${unusedKeys.length}`);
        console.log();
        log(`Keys not found in code (may be dynamically generated):`, 'yellow');
        unusedKeys.forEach(key => {
            console.log(colors.gray + `  - ${key}` + colors.reset);
        });
        console.log();
        logInfo('Note: Some keys might be used dynamically or in templates.');
    } else {
        logSuccess('All translation keys are used in the code!');
    }
}

/**
 * Create a new translation file template
 */
function createTranslationTemplate(lang) {
    if (!lang || !/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) {
        logError('Language code must be ISO 639-1 (e.g., es, fr, de) or with region (e.g., zh-HK, pt-BR)');
        return;
    }

    const filePath = path.join(LOCALES_DIR, `${lang}.json`);
    if (fs.existsSync(filePath)) {
        logError(`Translation file ${lang}.json already exists!`);
        return;
    }

    const baseTranslation = loadTranslation(BASE_LANG);
    if (!baseTranslation) {
        logError('Base translation file not found!');
        return;
    }

    // Create template with empty strings or base values as comments
    const template = {};
    Object.keys(baseTranslation).sort().forEach(key => {
        template[key] = baseTranslation[key]; // Start with English, translator will replace
    });

    fs.writeFileSync(filePath, JSON.stringify(template, null, 4) + '\n', 'utf8');
    logSuccess(`Created translation template: ${filePath}`);
    logInfo(`Now edit ${lang}.json and translate the English values to ${lang.toUpperCase()}`);
}

/**
 * Show translation statistics for all languages
 */
function showStats() {
    const languages = getAvailableLanguages();
    const baseTranslation = loadTranslation(BASE_LANG);

    if (!baseTranslation) {
        logError('Base translation file not found!');
        return;
    }

    const baseKeyCount = Object.keys(baseTranslation).length;

    console.log();
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
    log(`Translation Statistics`, 'bold');
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
    console.log();
    log(`Base language: ${BASE_LANG} (${baseKeyCount} keys)`, 'cyan');
    console.log();

    const stats = languages
        .filter(lang => lang !== BASE_LANG)
        .map(lang => {
            const translation = loadTranslation(lang);
            if (!translation) return null;

            const keys = Object.keys(translation);
            const completion = Math.round((keys.length / baseKeyCount) * 100);
            const missingCount = baseKeyCount - keys.length;

            return {
                lang,
                keys: keys.length,
                completion,
                missingCount
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.completion - a.completion);

    console.log('Language | Keys       | Completion | Status');
    console.log('---------|------------|------------|--------');

    stats.forEach(({ lang, keys, completion, missingCount }) => {
        const status = completion === 100 ? colors.green + '✓ Complete' :
                      completion >= 90 ? colors.yellow + '⚠ Almost' :
                      colors.red + '✗ Incomplete';

        console.log(
            `${lang.padEnd(8)} | ` +
            `${keys}/${baseKeyCount}`.padEnd(10) + ` | ` +
            `${completion}%`.padEnd(10) + ` | ` +
            status + colors.reset +
            (missingCount > 0 ? colors.gray + ` (-${missingCount})` + colors.reset : '')
        );
    });

    console.log();
    logInfo(`Total languages: ${stats.length + 1} (including ${BASE_LANG})`);
}

/**
 * Show help message
 */
function showHelp() {
    console.log(`
${colors.bold}Translation Validation and Helper Script${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node scripts/validate-translations.js [command] [options]

${colors.cyan}Commands:${colors.reset}
  ${colors.green}validate [lang]${colors.reset}
      Validate one or all translation files against the base (en.json)
      Examples:
        node scripts/validate-translations.js validate
        node scripts/validate-translations.js validate es

  ${colors.green}find-unused${colors.reset}
      Find translation keys that are not referenced in the JavaScript code
      Example:
        node scripts/validate-translations.js find-unused

  ${colors.green}create <lang>${colors.reset}
      Create a new translation file template for the specified language
      Language can be 2-letter code (pl, es) or region-specific (zh-HK, pt-BR)
      Example:
        node scripts/validate-translations.js create pl
        node scripts/validate-translations.js create zh-HK

  ${colors.green}stats${colors.reset}
      Show translation completion statistics for all languages
      Example:
        node scripts/validate-translations.js stats

  ${colors.green}help${colors.reset}
      Show this help message

${colors.cyan}Examples:${colors.reset}
  # Validate all translations
  node scripts/validate-translations.js validate

  # Validate Spanish translation only
  node scripts/validate-translations.js validate es

  # Find unused translation keys
  node scripts/validate-translations.js find-unused

  # Create new Polish translation
  node scripts/validate-translations.js create pl

  # Create new Traditional Chinese (Hong Kong) translation
  node scripts/validate-translations.js create zh-HK

  # Show statistics
  node scripts/validate-translations.js stats
`);
}

/**
 * Main execution
 */
function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';

    switch (command) {
        case 'validate': {
            const targetLang = args[1];
            const languages = targetLang
                ? [targetLang]
                : getAvailableLanguages().filter(lang => lang !== BASE_LANG);

            if (languages.length === 0) {
                logError('No translation files found!');
                process.exit(1);
            }

            let allValid = true;
            languages.forEach(lang => {
                const result = validateTranslation(lang, true);
                if (!result.valid) {
                    allValid = false;
                }
            });

            if (!allValid) {
                console.log();
                logError('Some translations have errors!');
                process.exit(1);
            } else {
                console.log();
                logSuccess('All translations are valid!');
            }
            break;
        }

        case 'find-unused':
            findUnusedKeys();
            break;

        case 'create':
            if (!args[1]) {
                logError('Please specify a language code (e.g., pl, ru, ja)');
                showHelp();
                process.exit(1);
            }
            createTranslationTemplate(args[1]);
            break;

        case 'stats':
            showStats();
            break;

        case 'help':
        default:
            showHelp();
            break;
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = {
    validateTranslation,
    findUnusedKeys,
    createTranslationTemplate,
    showStats
};

# Contributing Translations

Help translate JE's interface into your language or improve existing strings. You can contribute through Weblate without a local development setup.

## Translate on Weblate (Recommended)

Weblate keeps translation work in one place and provides quality checks.

[![Translation status](https://hosted.weblate.org/widget/jellyfinenhanced/287x66-grey.png)](https://hosted.weblate.org/engage/jellyfinenhanced/)

1. Open the [Jellyfin Enhanced project on Weblate](https://hosted.weblate.org/projects/jellyfinenhanced/).
2. Choose your language, or request a new language through the project.
3. Translate or improve strings using the English source and available context.
4. Review the validation feedback and save your changes.

Use the [project engagement page](https://hosted.weblate.org/engage/jellyfinenhanced/) to find languages that need help.

## Preserve functional text

Translate the visible wording while keeping the parts the interface needs to work. Use consistent wording across related controls. Check long strings in context where possible, especially buttons, notifications, and dialogs.

!!! note

    Translate values, not JSON keys. Do not replace a missing translation with an empty string. Untranslated strings fall back to English.

??? note "Details"

    Preserve these parts exactly:

    - Variables such as `{count}`, `{query}`, or `{userName}`. They may move within a sentence, but must retain their names and braces.
    - Icon tokens such as `{{icon:search}}`.
    - Functional HTML, such as `<kbd>`, `<br>`, and links. Translate visible text without breaking the markup or changing required attributes.
    - Escape sequences and valid JSON syntax. For example, a newline inside a JSON string is written as `\n`.

## Maintainer Fallback: Manual JSON Changes

When Weblate is unavailable, maintainers can update locale JSON in the repository. Prefer the Weblate workflow for normal contributions so edits stay coordinated.

1. Work in `Jellyfin.Plugin.JellyfinEnhanced/js/locales/`.
2. For an existing language, edit its JSON file. For a new language, copy `en.json` and name the file with its language code, such as `es.json`; follow the existing naming convention for regional variants.
3. Translate string values while preserving keys, placeholders, icon tokens, and functional markup.
4. From the repository root, validate the changed language:

    ```bash
    node scripts/validate-translations.js validate es
    ```

    Replace `es` with your language code. To validate every locale:

    ```bash
    node scripts/validate-translations.js validate
    ```

5. Fix errors and review warnings, then submit a pull request describing the language and changes.

A passing check does not replace reviewing grammar, meaning, or layout.

??? info "How it works"

    The validator compares locales with `en.json`. Missing keys are errors; extra keys and empty strings produce warnings. For source strings that contain placeholders, missing placeholders are errors and extra placeholders produce warnings.

    It does not detect added placeholders in a string whose English source has none, so review those manually. Validation errors return a nonzero exit status.

## Translation Updates

Merged translations normally reach your installed plugin with a plugin release. They do not immediately replace translations included with the version you already have.

1. To select a language, open personal **Settings** → **Language Settings** → **Display Language**.
2. Choose your language. JE saves your choice to your account and browser, then reloads the page.

**Clear Translation Cache** removes this browser's saved translations and reloads. It normally loads the translation included with your installed plugin again.

??? info "How it works"

    When you open JE, it looks for translations in this order:

    1. A copy saved in your browser for the installed plugin version, valid for 24 hours.
    2. The translation included with your installed plugin, using the base language if the selected regional translation is not included.
    3. A translation from the repository, downloaded through your Jellyfin server, if your installed translation is unavailable.

    JE uses English if it cannot load your selected language.

    For a regional choice such as `fr-CA`, JE uses included French (`fr`) if Canadian French is not included. If no matching included translation can be loaded, JE tries the regional translation from the repository and may then use English without trying the repository's base-language translation.

    The language menu lists translations included with your plugin and checks GitHub for newly added languages. Seeing a new language in the menu does not mean the translations you already have were updated from the repository.

    **Refresh Translation Cache** asks all clients to clear their saved translations on their next page load. This scheduled task runs when Jellyfin starts by default.

See [How do I change the plugin's language?](faq.md#how-do-i-change-the-plugins-language) for administrator defaults and personal overrides.

If a translated string is wrong, report it through Weblate. Include the language, affected screen, English source or string key, and suggested correction. Use [Support & Community](support.md) if you need help finding the string.

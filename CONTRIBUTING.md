# Contributing to Jellyfin Enhanced

Thank you for your interest in contributing to Jellyfin Enhanced! This document provides guidelines and information to help you get started.

## 🤝 Ways to Contribute

### 1. Code Contributions

You can contribute code through:
- **Open Pull Requests**: Check the [open PRs](https://github.com/n00bcodr/Jellyfin-Enhanced/pulls) for issues that need help
- **Discussions**: Browse [Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions) for feature requests and ideas that interest you
- **Bug Fixes**: Fix any bugs you encounter and submit a PR

> [!NOTE]
> Feature requests that are considered niche use cases are often moved to Discussions. Feel free to implement any of these if they interest you!

### 2. Translation Contributions

Help make Jellyfin Enhanced accessible to more users by contributing translations through Weblate:

- https://hosted.weblate.org/projects/jellyfinenhanced/

See the [Contributing Translations](https://n00bcodr.github.io/Jellyfin-Enhanced/faq-support/contributing-translations/) section for details.


## 🚀 Getting Started


### Project Structure

Before contributing, familiarize yourself with the project structure. See the [Project Structure](https://n00bcodr.github.io/Jellyfin-Enhanced/advanced/project-structure/) documentation page for a detailed breakdown of the codebase and what each file does.

Key directories:
- `Jellyfin.Plugin.JellyfinEnhanced/js/core/` - Shared layer (API client, navigation, lifecycle, DOM observers, UI primitives, tag renderer base)
- `Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/` - Core functionality (settings panel, player, bookmarks, hidden content, Spoiler Guard)
- `Jellyfin.Plugin.JellyfinEnhanced/js/elsewhere/` - Elsewhere and reviews functionality
- `Jellyfin.Plugin.JellyfinEnhanced/js/extras/` - Other Scripts
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/` - Seerr integration (UI, More Info modal, discovery, recommendations)
- `Jellyfin.Plugin.JellyfinEnhanced/js/arr/` - *arr integration including calendar and requests
- `Jellyfin.Plugin.JellyfinEnhanced/js/tags/` - Tag scripts (genre, language, people, quality, rating, user review)
- `Jellyfin.Plugin.JellyfinEnhanced/js/others/` - Miscellaneous scripts (letterboxd, splashscreen)
- `Jellyfin.Plugin.JellyfinEnhanced/js/locales/` - Translation files

Adding a client module:

1. Create the file in the directory for its feature, **following the naming already used in that directory**. The recently split page-style directories use concern suffixes (`-styles`, `-data`, `-render`, `-actions`, `-init`, `-custom-tab`); others use bare names or a different prefix.
2. Register it in the `allComponentScripts` array in `js/plugin.js`, **after** every module whose exports it reads at load time — scripts execute in array order, and nothing validates it.
3. Avoid hyphens in new directory names. Embedded-resource names are derived from the file path and a hyphen in a *directory* segment is rewritten to an underscore, which makes the module unreachable at runtime.
4. No `.csproj` change is needed — `js\**` is embedded by a glob — but the plugin must be rebuilt and redeployed for a new file to be served.

## 📝 Code Contribution Guidelines

### Code Style

1. **Comments are Essential**

   - Use JSDoc comments for functions and classes
   - Add inline comments to explain complex logic
   - Document parameters, return values, and side effects

   Example:
   ```javascript
   /**
    * Creates a bookmark at the specified timestamp
    * @param {string} itemId - The Jellyfin item ID
    * @param {number} timestamp - The video timestamp in seconds
    * @param {string} label - User-provided label for the bookmark
    * @returns {Promise<Object>} The created bookmark object
    */
   async function createBookmark(itemId, timestamp, label) {
       // Validate timestamp is within video duration
       if (timestamp > videoDuration) {
           throw new Error('Timestamp exceeds video duration');
       }

       // Create bookmark object with metadata
       const bookmark = {
           id: generateId(),
           itemId,
           timestamp,
           label,
           createdAt: new Date().toISOString()
       };

       return await saveBookmark(bookmark);
   }
   ```

2. **Code Understanding**

   - Ensure you understand what your changes do
   - Be prepared to answer questions about your implementation
   - Test your changes thoroughly

3. **AI-Assisted Code (VibeCoded PRs)**

   - AI-assisted contributions are welcome! However:
     - You must understand what the code does
     - Be able to explain your implementation
     - Respond to code review comments
     - Clearly indicate in your PR description that AI tools were used

   Example PR description:
   ```markdown
   ## Description
   Adds feature X to improve Y

   ## Implementation Notes
   This PR was developed with AI assistance (Claude/GPT/etc.). I have reviewed
   and tested all changes and understand the implementation.

   ## Testing
   - [ ] Tested on Jellyfin 10.11
   - [ ] Verified no basic errors
   ```

### Pull Request Process

1. **Fork and Branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/bug-description
   ```

2. **Make Your Changes**

   - Write clean, commented code
   - Follow existing code patterns
   - Test thoroughly

3. **Commit Messages**

   - Use clear, descriptive commit messages
   - Reference issues when applicable

   Example:
   ```
   feat: add bookmark sync across duplicate items

   - Implements automatic bookmark syncing based on TMDB/TVDB IDs
   - Adds UI option to manage sync preferences
   - Fixes #123
   ```

4. **Submit PR**

   - Provide a clear description of changes
   - Include screenshots/videos for UI changes as applicable
   - List any breaking changes
   - Mention if you used AI assistance

5. **Code Review**

   - Be responsive to feedback
   - Be prepared to make requested changes
   - If you want me to make any further changes, let me know

## ✅ CI Checks

Every PR runs a few automated checks (GitHub Actions, `.github/workflows/`). There are no automated tests to run locally - these are all static checks:

| Check | What it does | Reproduce locally |
|---|---|---|
| **CodeQL Advanced** | Static analysis for both the C# backend and the JS frontend, looking for common security/correctness bug patterns | Not practical to run locally; check the PR's "Files changed" annotations if it flags something |
| **Dependency Review** | Flags newly-introduced dependencies with known vulnerabilities or incompatible licenses | Only relevant if your PR changes `.csproj` package references |
| **Security Scan** | Scans the diff for accidentally-committed secrets (API keys, tokens, credentials) with TruffleHog | `git diff` your changes yourself before pushing if you're unsure |
| **Translation Checks** | For any locale file you touched under `js/locales/`, verifies it has valid JSON and the same key set as `en.json` (no missing/extra keys) | Diff your changed locale file's keys against `js/locales/en.json` by hand, or just keep the two in sync as you edit |

Two more workflows exist but aren't part of the PR gate: **Check Unused Translation Keys** and **OpenSSF Scorecard** are both maintainer-triggered/scheduled, not run against your PR - a scorecard badge or unused-key report you might see elsewhere in the repo isn't something your PR needs to pass.

## 🧪 Testing

Before submitting a PR, ensure you've tested:

- [ ] Feature works as expected
- [ ] No console errors
- [ ] Compatible with Jellyfin 10.11.x
- [ ] Works on different browsers (Chrome, Firefox, Edge)
- [ ] Doesn't break existing functionality
- [ ] Mobile compatibility (if applicable)

## 📋 Feature Request Guidelines

When proposing new features:

1. **Check Discussions First**: Your idea might already be there!
2. **Provide Context**: Explain the use case and benefit
3. **Be Specific**: Clear descriptions help implementation
4. **Consider Scope**: Is this a core feature or niche use case?

## 🐛 Bug Reports

When reporting bugs:

1. **Check Existing Issues**: Avoid duplicates
2. **Check FAQs**
3. **Provide Details** as per the Bug report template

## 💬 Getting Help

If you have questions or need help:

- **Discord**: Reach out on the [Jellyfin Community Discord](https://discord.gg/EYNFf7y4CG)
- **Discussions**: Start a discussion on GitHub
- **Issues**: For bug-related questions

## 🎨 UI/UX Contributions

For UI changes:

- Test with different Jellyfin themes
- Provide before/after screenshots

---

**Thank you for contributing to Jellyfin Enhanced! Your efforts help make Jellyfin better for everyone.** 💜
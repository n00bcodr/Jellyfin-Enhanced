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

Help make Jellyfin Enhanced accessible to more users by contributing translations! See the [Internationalization & Translations](README.md#-internationalization--translations) section in the README for details.


## 🚀 Getting Started


### Project Structure

Before contributing, familiarize yourself with the project structure. See the [Project Structure](README.md#-project-structure) section in the README for a detailed breakdown of the codebase and what each file does.

Key directories:
- `Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/` - Core functionality
- `Jellyfin.Plugin.JellyfinEnhanced/js/extras/` - n00bcodr's Personal Scripts
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/` - Jellyseerr integration
- `Jellyfin.Plugin.JellyfinEnhanced/js/arr/` - *arr integration including calendar and requests
- `Jellyfin.Plugin.JellyfinEnhanced/js/locales/` - Translation files

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
   - [ ] Tested on Jellyfin 10.10
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

## 🧪 Testing

Before submitting a PR, ensure you've tested:

- [ ] Feature works as expected
- [ ] No console errors
- [ ] Compatible with Jellyfin 10.10 and 10.11
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

- **Discord**: Reach out on the [Jellyfin Community Discord](https://discord.com/channels/1381737066366242896/1442128048873930762)
- **Discussions**: Start a discussion on GitHub
- **Issues**: For bug-related questions

## 🎨 UI/UX Contributions

For UI changes:

- Test with different Jellyfin themes
- Provide before/after screenshots

---

**Thank you for contributing to Jellyfin Enhanced! Your efforts help make Jellyfin better for everyone.** 💜
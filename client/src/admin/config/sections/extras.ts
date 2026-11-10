import type { DefineSections } from '../engine/schema';

export function defineExtras(define: DefineSections): void {
/* Extras and Keyboard tab sections. See jeAdmin.js for the field spec. */
    const shot = (alt: string, file: string, small?: boolean): string => '<details class="je-screenshot-details"><summary class="je-screenshot-summary">View Screenshot</summary>'
        + '<a href="https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/docs/images/' + file + '" target="_blank">'
        + '<img alt="' + alt + '" class="' + (small ? 'je-screenshot-img-sm' : 'je-screenshot-img') + '" data-je-cdn="je-docs-img/' + file + '"/></a></details>';

    define({
        'extras-ui': {
            title: 'UI Tweaks', icon: 'palette',
            items: [
                { id: 'coloredRatingsEnabled', prop: 'ColoredRatingsEnabled', type: 'toggle', label: 'Colored Ratings Backgrounds',
                  desc: 'Applies color-coded backgrounds to media ratings. If you notice missing or incorrect ratings, please submit a PR to <a class="sectionTitle" href="https://github.com/n00bcodr/Jellyfin-Enhanced/" target="_blank">Jellyfin-Enhanced</a>.' + shot('Colored Ratings Example', 'ratings.png') },
                { id: 'themeSelectorEnabled', prop: 'ThemeSelectorEnabled', type: 'toggle', label: 'Theme Selector (Jellyfish)',
                  desc: 'Adds a theme selector to quickly switch between Jellyfish color themes. Only changes the color theme of Jellyfish when used natively, not through KefinTweaks.' + shot('Theme Selector Example', 'theme-selector.png') },
                { id: 'coloredActivityIconsEnabled', prop: 'ColoredActivityIconsEnabled', type: 'toggle', label: 'Colored Dashboard Icons',
                  desc: 'Replaces Dashboard Activity Icons with Material Design icons and background color.' + shot('Colored Activity Icons Example', 'colored-activity-icons.png') },
                { id: 'loginImageEnabled', prop: 'EnableLoginImage', type: 'toggle', label: 'Profile Picture on Login',
                  desc: 'Displays the user\'s profile picture on the manual login screen instead of the name. When a user is selected, their avatar appears above the password field.' + shot('Login Image Example', 'login-image.png') },
                { id: 'pluginIconsEnabled', prop: 'PluginIconsEnabled', type: 'toggle', label: 'Custom Plugin Menu Icons',
                  desc: 'Replaces default plugin folder icons with custom icons on the Dashboard sidebar. Currently replaces icons for (if installed): Jellyfin Enhanced, JavaScript Injector, Intro Skipper, Reports, JellySleep, Home Screen Sections, File Transformation, Jellyfin Helper, Newsletters, Segment Editor and Moonbase.' + shot('Plugin Icons Example', 'plugin-icons.png', true) }
            ]
        },
        'extras-streams': {
            title: 'Active Streams', icon: 'podcasts',
            items: [
                { id: 'activeStreamsEnabled', prop: 'ActiveStreamsEnabled', type: 'toggle', main: true, label: 'Active Streams Header Widget',
                  desc: 'Adds a live stream counter to the header. Click it to open a panel showing who is currently playing, what they\'re watching, playback state, progress, and transcoding details. By default the widget is only visible to admin accounts.' },
                { id: 'activeStreamsAllUsers', prop: 'ActiveStreamsAllUsers', type: 'toggle', label: 'Show widget to non-admins' }
            ]
        },
        'extras-links': {
            title: 'External Links', icon: 'link',
            items: [
                { id: 'letterboxdEnabled', prop: 'LetterboxdEnabled', type: 'toggle', main: true, label: 'Enable Letterboxd Links',
                  desc: 'Adds Letterboxd links to movie and person details pages.' },
                { id: 'showLetterboxdLinkAsText', prop: 'ShowLetterboxdLinkAsText', type: 'toggle', label: 'Show link as text',
                  desc: 'When enabled, shows "Letterboxd" as text instead of the Letterboxd icon.' }
            ]
        },
        'extras-metadata-icons': {
            title: 'Metadata Icons & Sidebar Links', icon: 'extension',
            items: [
                { id: 'metadataIconsEnabled', prop: 'MetadataIconsEnabled', type: 'toggle', label: 'Enable Metadata Icons (Druidblack)',
                  fromConfig: (v) => !!v,
                  desc: 'Shows metadata icons instead of text. When enabled, links from the plugin will also use icons instead of text (Letterboxd, *arr Links).' },
                { type: 'group', title: 'Sidebar custom links', items: [
                    { id: 'customPluginLinks', prop: 'CustomPluginLinks', type: 'textarea', rows: 3, placeholder: 'Page Name | icon_name', label: 'Sidebar Custom Links',
                      desc: '<strong>Format:</strong> <code>Configuration Page Name | Material Icon Name</code><br/>'
                          + '<strong>Important:</strong> Use the exact name that appears in the configuration page URL (e.g., "Jellyfin%20Tweaks" becomes "Jellyfin Tweaks").<br/>'
                          + '<a class="sectionTitle" href="https://fonts.google.com/icons?icon.set=Material+Icons" target="_blank">Browse Material Icons</a><br/>'
                          + 'Use "Test Links" to preview your links in the sidebar. They appear immediately and disappear on page refresh.' },
                    { type: 'button', id: 'testCustomPluginLinksBtn', label: 'Test Links' }
                ] }
            ]
        },
        'extras-splash': {
            title: 'Splash Screen Override', icon: 'wallpaper',
            items: [
                { id: 'enableCustomSplashScreen', prop: 'EnableCustomSplashScreen', type: 'toggle', main: true, label: 'Enable Splash Screen Override',
                  desc: 'Replace Jellyfin\'s login splash background with a custom image URL specified below.' },
                { id: 'splashScreenImageUrl', prop: 'SplashScreenImageUrl', type: 'text', placeholder: '/web/assets/banner.png', label: 'Splash Screen Image URL',
                  desc: 'URL for the splash screen image. Defaults to Jellyfin banner.' },
                { type: 'note', tone: 'warn', html: 'Might cause strange behaviour if <a class="sectionTitle" href="https://github.com/IAmParadox27/jellyfin-plugin-media-bar" target="_blank">jellyfin-plugin-media-bar</a> is installed. All changes require a page refresh; if old settings persist, force clear the browser cache.' }
            ]
        },
        'extras-branding': {
            title: 'Custom Image Assets', icon: 'image', class: 'je-fieldset-wide',
            items: [
                { type: 'note', html: 'Uploaded icon / favicon / logo images are applied automatically at request time. Changes apply on next page load (a hard refresh may be needed if your browser cached the old image).' },
                { type: 'custom', html: '<div class="je-branding-grid">' + [
                    ['iconTransparent', 'Icon Transparent', 'The icon in the top-left beside the server version', '536×536px &nbsp;·&nbsp; PNG with transparency'],
                    ['favicon', 'Favicon', 'Favicon in the browser tab', '256×256px (.png) &nbsp;·&nbsp; ICO, PNG, or SVG'],
                    ['bannerDark', 'Banner Dark', 'Splash Screen Banner for Light Mode', '1302×378px &nbsp;·&nbsp; PNG, JPG, or WebP'],
                    ['bannerLight', 'Banner Light', 'Splash Screen Banner for Dark Mode', '1302×378px &nbsp;·&nbsp; PNG, JPG, or WebP'],
                    ['touchicon', 'Apple Touch Icon', 'Icon shown when adding to iOS Home Screen', '180×180px &nbsp;·&nbsp; PNG']
                ].map(([k, name, what, size]) => '<div class="je-branding-card">'
                    + '<label class="je-branding-label-bold">' + name + '</label>'
                    + '<label class="je-branding-label">' + what + '</label>'
                    + '<div class="je-branding-size-hint">' + size + '</div>'
                    + '<div class="je-branding-dropzone" id="' + k + 'DropZone">'
                    + '<input type="file" id="' + k + 'Input" accept="image/*" class="je-branding-file-input" />'
                    + '<div id="' + k + 'Placeholder" class="je-branding-placeholder"><i class="material-icons je-branding-placeholder-icon">image</i></div>'
                    + '<img id="' + k + 'Preview" class="je-branding-preview" style="display:none;" />'
                    + '<div id="' + k + 'Dimensions" class="je-branding-dimensions" style="display:none;"></div>'
                    + '<div id="' + k + 'Status" class="je-branding-status"></div>'
                    + '<button type="button" class="je-branding-delete" id="' + k + 'Delete" style="display:none;"><i class="material-icons">delete</i></button>'
                    + '</div></div>').join('') + '</div>' }
            ]
        },
        'keyboard': {
            title: 'Keyboard Shortcuts', icon: 'keyboard',
            items: [
                { id: 'disableAllShortcuts', prop: 'DisableAllShortcuts', type: 'toggle', label: 'Disable Keyboard Shortcuts',
                  desc: 'Disables all keyboard shortcuts, and hides the "Shortcuts" tab in the Enhanced Panel.' },
                { type: 'note', html: '<strong>Users can customize their own settings from the Enhanced Panel:</strong> press <code>?</code> (default shortcut), long-press the profile picture in the top-right corner, use the "Jellyfin Enhanced" link in the sidebar, or open it from the playback controls menu (mobile only).' },
                { type: 'html', html: '<div class="fieldDescription je-sc-help">Click a key, then press the new key combination (for example <kbd>Shift+A</kbd>). <b>Delete</b> disables the shortcut for every user, <b>Backspace</b> restores its default. Users can still change their own keys from their Enhanced Panel.</div>'
                    + '<div id="shortcut-error-comment" style="display: none; color: #ff6b6b; margin-top:5px;"></div>'
                    + '<div id="shortcut-grid"></div>' }
            ]
        }
    });
}

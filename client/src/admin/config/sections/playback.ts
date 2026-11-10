import type { DefineSections } from '../engine/schema';

export function definePlayback(define: DefineSections): void {
/* Playback tab sections. See jeAdmin.js for the field spec. */
define({
    'pb-tabswitch': {
        title: 'Player Behaviour', icon: 'play_circle',
        items: [
            { id: 'autoPauseEnabled', prop: 'AutoPauseEnabled', type: 'toggle', perUser: true, label: 'Auto-pause on tab switch',
              desc: 'Pause playback automatically when you switch to another browser tab.' },
            { id: 'autoResumeEnabled', prop: 'AutoResumeEnabled', type: 'toggle', perUser: true, label: 'Auto-resume on tab switch',
              desc: 'Resume playback automatically when you switch back to the player tab.' },
            { id: 'autoPipEnabled', prop: 'AutoPipEnabled', type: 'toggle', perUser: true, label: 'Auto Picture-in-Picture on tab switch',
              desc: 'Enter the browser\'s Picture-in-Picture mode when switching tabs (browser support required).' },
            { id: 'longPress2xEnabled', prop: 'LongPress2xEnabled', type: 'toggle', perUser: true, label: 'Long press/hold for 2x speed β',
              desc: 'Long-press anywhere on the player to temporarily play at 2x speed; release to return to normal speed. Beta, touch devices only.' },
            { id: 'showPlaybackRatingBadge', prop: 'ShowPlaybackRatingBadge', type: 'toggle', label: 'Show Age Rating When Playback Starts',
              desc: 'Briefly shows the age rating in a corner of the player when a video starts, followed by a line of any content-advisory tags (such as violence or strong language) and a line of its genres.' },
            { id: 'pauseScreenEnabled', prop: 'PauseScreenEnabled', type: 'toggle', perUser: true, label: 'Enable Custom Pause Screen',
              desc: 'Shows an overlay with details about what is playing while playback is paused.' }
        ]
    },
    'pb-autoskip': {
        title: 'Auto-Skip', icon: 'skip_next',
        items: [
            { id: 'autoSkipIntro', prop: 'AutoSkipIntro', type: 'toggle', perUser: true, label: 'Auto-skip Intro',
              desc: 'Automatically skip detected intros. Requires the Intro Skipper plugin.' },
            { id: 'autoSkipOutro', prop: 'AutoSkipOutro', type: 'toggle', perUser: true, label: 'Auto-skip Outro',
              desc: 'Automatically skip detected outros (end credits). Requires the Intro Skipper plugin.' }
        ]
    },
    'pb-subtitles': {
        title: 'Subtitles', icon: 'subtitles',
        items: [
            { id: 'disableCustomSubtitleStyles', prop: 'DisableCustomSubtitleStyles', type: 'toggle', perUser: true, label: 'Disable Custom Subtitle Styles by default',
              desc: 'Globally disables Jellyfin\'s custom subtitle style overrides so the source subtitle styling is shown unmodified.' },
            { type: 'group', title: 'Default appearance for new users', open: true, items: [
                { id: 'DefaultSubtitleStyle', prop: 'DefaultSubtitleStyle', type: 'select', perUser: true, default: 0, label: 'Default Subtitle Style',
                  options: [['0', 'Clean White'], ['1', 'Classic Black Box'], ['2', 'Netflix Style'], ['3', 'Cinema Yellow'], ['4', 'Soft Gray'], ['5', 'High Contrast']],
                  toConfig: (v) => parseInt(String(v), 10),
                  desc: 'Default subtitle style preset applied to new users; users can override in their personal settings.' },
                { id: 'DefaultSubtitleSize', prop: 'DefaultSubtitleSize', type: 'select', perUser: true, default: 0, label: 'Default Subtitle Size',
                  options: [['0', 'Tiny'], ['1', 'Small'], ['2', 'Normal'], ['3', 'Large'], ['4', 'Extra Large'], ['5', 'Gigantic']],
                  toConfig: (v) => parseInt(String(v), 10),
                  desc: 'Default subtitle size applied to new users; users can override in their personal settings.' },
                { id: 'DefaultSubtitleFont', prop: 'DefaultSubtitleFont', type: 'select', perUser: true, default: 0, label: 'Default Subtitle Font',
                  options: [['0', 'Default'], ['1', 'Noto Sans'], ['2', 'Sans Serif'], ['3', 'Typewriter'], ['4', 'Roboto']],
                  toConfig: (v) => parseInt(String(v), 10),
                  desc: 'Default subtitle font applied to new users; users can override in their personal settings.' },
                { id: 'DefaultSubtitleTextEffect', prop: 'DefaultSubtitleTextEffect', type: 'select', perUser: true, default: 0, label: 'Default Subtitle Text Effect',
                  options: [['0', 'Auto'], ['1', 'None'], ['2', 'Shadow'], ['3', 'Outline'], ['4', 'Outline + Shadow']],
                  toConfig: (v) => parseInt(String(v), 10),
                  desc: 'Default subtitle text effect (outline / drop shadow) applied to new users; users can override in their personal settings. Auto adds a shadow only when the subtitle background is transparent.' }
            ] }
        ]
    },
    'pb-timing': {
        title: 'Shortcuts Panel & Toast Timing', icon: 'timer',
        items: [
            { id: 'HelpPanelAutocloseDelay', prop: 'HelpPanelAutocloseDelay', type: 'number', default: 15000, min: 0, step: 1, label: 'Shortcuts Panel Autoclose Delay (ms)',
              desc: 'How long the Jellyfin Enhanced shortcuts/settings panel (opened with the <kbd>?</kbd> key) stays open without interaction before auto-closing. Default: 15000 ms (15 seconds).' },
            { type: 'button', id: 'jeTestShortcutsPanel', label: 'Preview autoclose' },
            { id: 'ToastDuration', prop: 'ToastDuration', type: 'number', default: 3000, min: 0, step: 1, label: 'Toast Notification Duration (ms)',
              desc: 'How long pop-up toast messages (e.g. &ldquo;Shuffle enabled&rdquo;, &ldquo;Bookmark saved&rdquo;) stay on-screen before fading out. Default: 3000 ms (3 seconds). Set to <strong>0</strong> to turn toasts off. Use 1000 or more so they can be read; the preview uses the value you typed, before saving.' },
            { type: 'button', id: 'jeTestToast', label: 'Preview toast' }
        ]
    }
});
}

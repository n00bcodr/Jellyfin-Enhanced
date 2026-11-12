import { playerHost } from './host';
import { createPlayerLifetime } from './lifetime';
import { getCurrentVideoItemId } from './identity';
import { installFrameSeek } from './frame-seek';
import { installSegmentControls } from './segment-controls';
import { createTrackMenu } from './native-track-menu';
import { installTrackControls } from './track-controls';
import { installAspect } from './normal-aspect';
import { installPlaybackInfo } from './playback-info';
import { installLongPress } from './long-press';
const { JE, ApiClient, ctx } = playerHost();
const lifetime = createPlayerLifetime(JE, 'playback');
const getVideo = () => document.querySelector('video');
const _tFallbackWarned = new Set<string>();
    function tWithFallback(key: string, fallback: string, params?: Record<string, string | number>) {
        let result;
        try {
            result = JE.t(key, params);
        } catch (err) {
            console.warn(`🪼 Jellyfin Enhanced: JE.t('${key}') threw, using fallback:`, err);
            result = null;
        }
        if (!result || result === key) {
            if (!_tFallbackWarned.has(key)) {
                _tFallbackWarned.add(key);
                console.warn(`🪼 Jellyfin Enhanced: missing translation key '${key}', using inline fallback`);
            }
            let out = fallback;
            if (params) {
                for (const [k, v] of Object.entries(params)) {
                    out = out.split(`{${k}}`).join(String(v));
                }
            }
            return out;
        }
        return result;
    }
    /**
     * Finds the main settings button in the video player OSD.
     * @returns {HTMLElement|null} The settings button element.
     */
    const settingsBtn = () => document.querySelector<HTMLElement>(
    '.videoOsdBottom .btnVideoOsdSettings, .videoOsdBottom button[title="Settings"], .videoOsdBottom button[aria-label="Settings"]'
    );

    JE.openSettings = (cb) => {
        settingsBtn()?.click();
        lifetime.timeout(cb, 120); // Wait for the menu to animate open
    };

    /**
     * Adjusts playback speed up or down through a predefined list of speeds.
     * @param {string} direction Either 'increase' or 'decrease'.
     */
    JE.adjustPlaybackSpeed = (direction) => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        const speeds = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
        let currentIndex = speeds.findIndex(speed => Math.abs(speed - video.playbackRate) < 0.01);
        if (currentIndex === -1) {
            currentIndex = speeds.findIndex(speed => speed >= video.playbackRate);
            if (currentIndex === -1) currentIndex = speeds.length - 1;
        }
        if (direction === 'increase') {
            currentIndex = Math.min(currentIndex + 1, speeds.length - 1);
        } else {
            currentIndex = Math.max(currentIndex - 1, 0);
        }
        video.playbackRate = speeds[currentIndex] ?? 1;
        JE.toast(JE.t('toast_speed', { speed: video.playbackRate }));
    };

    /**
     * Resets the video playback speed to normal (1.0x).
     */
    JE.resetPlaybackSpeed = () => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        video.playbackRate = 1.0;
        JE.toast(JE.t('toast_speed_normal'));
    };

    /**
     * Jumps to a specific percentage of the video's duration.
     * @param {number} percentage The percentage to jump to (0-100).
     */
    JE.jumpToPercentage = (percentage) => {
        const video = getVideo();
        if (!video || !video.duration) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        video.currentTime = video.duration * (percentage / 100);
        JE.toast(JE.t('toast_jumped_to', { percent: percentage }));
    };


const context = { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback };
installFrameSeek(context);
installSegmentControls(context);
const menu = createTrackMenu(context);
const tracks = installTrackControls(context, menu.cycleTrackMenu);
installAspect(context);
installPlaybackInfo(context, tracks.probeOwnSession, tracks.trackDisplayName, menu);
installLongPress(context);
ctx.own.player = Object.assign(ctx.own.player || {}, { getVideo, getCurrentVideoItemId });

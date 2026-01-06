/**
 * @file Manages video playback controls and enhancements.
 */
(function(JE) {
    'use strict';

    /**
     * Finds the currently active video element on the page.
     * @returns {HTMLVideoElement|null} The video element or null if not found.
     */
    const getVideo = () => document.querySelector('video');

    /**
     * Finds the main settings button in the video player OSD.
     * @returns {HTMLElement|null} The settings button element.
     */
    const settingsBtn = () => document.querySelector(
    '.videoOsdBottom .btnVideoOsdSettings, .videoOsdBottom button[title="Settings"], .videoOsdBottom button[aria-label="Settings"]'
    );

    JE.openSettings = (cb) => {
        settingsBtn()?.click();
        setTimeout(cb, 120); // Wait for the menu to animate open
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
        video.playbackRate = speeds[currentIndex];
        JE.toast(JE.t('toast_speed', { speed: speeds[currentIndex] }));
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

    /**
     * Manually triggers the skip intro/outro button if it's visible.
     */
    JE.skipIntroOutro = () => {
        const skipButton = document.querySelector('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
        if (skipButton) {
            const buttonText = skipButton.textContent || '';
            skipButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            skipButton.click();
            
            if (buttonText.includes('Skip Intro')) {
                JE.toast(JE.t('toast_skipped_intro'));
            } else if (buttonText.includes('Skip Outro')) {
                JE.toast(JE.t('toast_skipped_outro'));
            } else {
                JE.toast('⏭️ Skipped');
            }
        } else {
            JE.toast(JE.t('toast_no_skip_button'));
        }
    };

    /**
     * Cycles through available subtitle tracks in the OSD menu.
     */
    JE.cycleSubtitleTrack = () => {
        const performCycle = () => {
            const allItems = document.querySelectorAll('.actionSheetContent .listItem');
            if (allItems.length === 0) {
                JE.toast(JE.t('toast_no_subtitles_found'));
                document.body.click();
                return;
            }

            const subtitleOptions = Array.from(allItems).filter(item => {
                const textElement = item.querySelector('.listItemBodyText');
                return textElement && textElement.textContent.trim() !== 'Secondary Subtitles';
            });

            if (subtitleOptions.length === 0) {
                JE.toast(JE.t('toast_no_subtitles_found'));
                document.body.click();
                return;
            }

            let currentIndex = subtitleOptions.findIndex(option => {
                const checkIcon = option.querySelector('.listItemIcon.check');
                return checkIcon && getComputedStyle(checkIcon).visibility !== 'hidden';
            });

            const nextIndex = (currentIndex + 1) % subtitleOptions.length;
            const nextOption = subtitleOptions[nextIndex];

            if (nextOption) {
                nextOption.click();
                const subtitleName = nextOption.querySelector('.listItemBodyText').textContent.trim();
                JE.toast(JE.t('toast_subtitle', { subtitle: subtitleName }));
            }
        };

        const subtitleMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Subtitles');
        if (subtitleMenuTitle) {
            performCycle();
        } else {
            if (document.querySelector('.actionSheetContent')) {
                document.body.click();
            }
            document.querySelector('button.btnSubtitles')?.click();
            setTimeout(performCycle, 200);
        }
    };

    /**
     * Cycles through available audio tracks in the OSD menu.
     */
    JE.cycleAudioTrack = () => {
        const performCycle = () => {
            const audioOptions = Array.from(document.querySelectorAll('.actionSheetContent .listItem')).filter(item => item.querySelector('.listItemBodyText.actionSheetItemText'));

            if (audioOptions.length === 0) {
                JE.toast(JE.t('toast_no_audio_tracks_found'));
                document.body.click();
                return;
            }

            let currentIndex = audioOptions.findIndex(option => {
                const checkIcon = option.querySelector('.actionsheetMenuItemIcon.listItemIcon.check');
                return checkIcon && getComputedStyle(checkIcon).visibility !== 'hidden';
            });

            const nextIndex = (currentIndex + 1) % audioOptions.length;
            const nextOption = audioOptions[nextIndex];

            if (nextOption) {
                nextOption.click();
                const audioName = nextOption.querySelector('.listItemBodyText.actionSheetItemText').textContent.trim();
                JE.toast(JE.t('toast_audio', { audio: audioName }));
            }
        };

        const audioMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Audio');
        if (audioMenuTitle) {
            performCycle();
        } else {
            if (document.querySelector('.actionSheetContent')) {
                document.body.click();
            }
            document.querySelector('button.btnAudio')?.click();
            setTimeout(performCycle, 200);
        }
    };

    /**
     * Cycles through video aspect ratio modes (Auto, Cover, Fill).
     */
    const performAspectCycle = () => {
        const opts = [...document.querySelectorAll('.actionSheetContent button[data-id="auto"], .actionSheetContent button[data-id="cover"], .actionSheetContent button[data-id="fill"]')];

        if (!opts.length) {
            document.querySelector('.actionSheetContent button[data-id="aspectratio"]')?.click();
            setTimeout(performAspectCycle, 120);
            return;
        }

        // If options are found, cycle them.
        const current = opts.findIndex(b => b.querySelector('.check')?.style.visibility !== 'hidden');
        const next = opts[(current + 1) % opts.length];
        if (next) {
            next.click();
            JE.toast(JE.t('toast_aspect_ratio', { ratio: next.textContent.trim() }));
        }
    };

    // The main function called by the shortcut to start the process.
    JE.cycleAspect = () => {
        // This opens the main settings panel ONCE and then hands off to the inner logic.
        JE.openSettings(performAspectCycle);
    };

    let skipButtonObserver = null;

    /**
     * Initializes a MutationObserver to watch for the skip button's appearance.
     */
    JE.initializeAutoSkipObserver = () => {
        if (skipButtonObserver) {
            return; // Observer is already running
        }
        skipButtonObserver = new MutationObserver((mutationsList) => {
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList' || mutation.type === 'attributes') {
                    const skipButton = document.querySelector('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
                    if (skipButton && !JE.state.skipToastShown) {
                        const buttonText = skipButton.textContent || '';
                        if (JE.currentSettings.autoSkipIntro && buttonText.includes('Skip Intro')) {
                            skipButton.click();
                            JE.toast(JE.t('toast_auto_skipped_intro'));
                            JE.state.skipToastShown = true;
                        } else if (JE.currentSettings.autoSkipOutro && buttonText.includes('Skip Outro')) {
                            skipButton.click();
                            JE.toast(JE.t('toast_auto_skipped_outro'));
                            JE.state.skipToastShown = true;
                        }
                    } else if (!skipButton) {
                        JE.state.skipToastShown = false; // Reset when the button is gone
                    }
                }
            }
        });

        skipButtonObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    };

    /**
     * Disconnects the MutationObserver for the skip button.
     */
    JE.stopAutoSkip = () => {
        if (skipButtonObserver) {
            skipButtonObserver.disconnect();
            skipButtonObserver = null;
        }
    };

    // --- Long Press Speed Control ---
    const LONG_PRESS_CONFIG = {
        DURATION: 500,
        SPEED_NORMAL: 1.0,
        SPEED_FAST: 2.0,
        MOVEMENT_THRESHOLD: 10, // pixels - ignore small movements
    };

    let pressTimer = null;
    let isLongPress = false;
    let videoElement = null;
    let originalSpeed = LONG_PRESS_CONFIG.SPEED_NORMAL;
    let speedOverlay = null;
    let pressStartX = null;
    let pressStartY = null;

    function createSpeedOverlay() {
        if (speedOverlay) return;
        speedOverlay = document.createElement('div');
        speedOverlay.setAttribute('data-speed-overlay', 'true');
        speedOverlay.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(0,0,0,0.9); color: white; padding: 20px 30px; border-radius: 8px;
            font-size: 2em; font-weight: bold; z-index: 999999;
            pointer-events: none; font-family: system-ui;
            opacity: 0; transition: opacity 0.2s ease-out; display: none;
        `;
        document.body.appendChild(speedOverlay);
    }

    function showOverlay(speed) {
        createSpeedOverlay();
        speedOverlay.textContent = `${speed}x${speed > 1 ? ' ⏩' : ' ▶️'}`;
        speedOverlay.style.display = 'block';
        setTimeout(() => speedOverlay.style.opacity = '1', 10);
    }

    function hideOverlay() {
        if (speedOverlay) {
            speedOverlay.style.opacity = '0';
            setTimeout(() => speedOverlay.style.display = 'none', 200);
        }
    }

    JE.handleLongPressDown = (e) => {
        if (!JE.currentSettings.longPress2xEnabled || (e.button !== undefined && e.button !== 0) || pressTimer) {
            return;
        }
        videoElement = getVideo();
        if (!videoElement) return;

        // Store initial press position
        pressStartX = e.clientX || e.touches?.[0]?.clientX;
        pressStartY = e.clientY || e.touches?.[0]?.clientY;

        originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
        isLongPress = false;

        pressTimer = setTimeout(() => {
            if (JE.state.pauseScreenClickTimer) {
                clearTimeout(JE.state.pauseScreenClickTimer);
                JE.state.pauseScreenClickTimer = null;
            }
            isLongPress = true;
            // Make sure video is playing when we activate speed boost
            if (videoElement.paused) {
                videoElement.play().catch(err => console.warn("🪼 Play blocked:", err));
            }
            videoElement.playbackRate = LONG_PRESS_CONFIG.SPEED_FAST;
            showOverlay(LONG_PRESS_CONFIG.SPEED_FAST);
            if (navigator.vibrate) navigator.vibrate(50);
        }, LONG_PRESS_CONFIG.DURATION);
    };

    JE.handleLongPressUp = (e) => {
        if (!pressTimer) return;
        clearTimeout(pressTimer);
        pressTimer = null;

        if (isLongPress) {
            const video = getVideo();
            if (video) {
                video.playbackRate = originalSpeed;
            }
            hideOverlay();
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
        isLongPress = false;
        pressStartX = null;
        pressStartY = null;
    };

    JE.handleLongPressCancel = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
            if (isLongPress) {
                const video = getVideo();
                if (video) {
                    video.playbackRate = originalSpeed;
                }
                hideOverlay();
            }
            isLongPress = false;
        }
        pressStartX = null;
        pressStartY = null;
    };

    // Handle mouse movement during press to detect drag/scrub
    JE.handleLongPressMove = (e) => {
        if (!pressTimer || isLongPress || !pressStartX || !pressStartY) return;

        const currentX = e.clientX || e.touches?.[0]?.clientX;
        const currentY = e.clientY || e.touches?.[0]?.clientY;

        if (currentX === null || currentY === null) return;

        const distanceMoved = Math.sqrt(
            Math.pow(currentX - pressStartX, 2) + Math.pow(currentY - pressStartY, 2)
        );

        // If user moves more than threshold, cancel the long press (likely a drag attempt)
        if (distanceMoved > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD) {
            clearTimeout(pressTimer);
            pressTimer = null;
            pressStartX = null;
            pressStartY = null;
        }
    };

    // Block click events that would pause/play when doing a long press
    JE.handleLongPressClick = (e) => {
        // If long press is just completed OR user is still holding (timer active),
        // prevent the click from pausing the video
        if (isLongPress || pressTimer) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
    };

})(window.JellyfinEnhanced);
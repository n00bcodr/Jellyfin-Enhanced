/**
 * @file Settings/help panel HTML template (shortcuts tab, settings sections,
 * footer) built from the shared panel context.
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const { GITHUB_REPO } = internal;

    const escapeHtml = JE.escapeHtml;

    // JE.t returns the raw key on miss; substitute the inline fallback. Mirrors elsewhere/reviews.js.
    const _tFallbackWarned = new Set();
    function tWithFallback(key, fallback) {
        let result;
        try {
            result = JE.t(key);
        } catch (err) {
            console.warn(`🪼 Jellyfin Enhanced: JE.t('${key}') threw, using fallback:`, err);
            result = null;
        }
        if (!result || result === key) {
            if (!_tFallbackWarned.has(key)) {
                _tFallbackWarned.add(key);
                console.warn(`🪼 Jellyfin Enhanced: missing translation key '${key}', using inline fallback`);
            }
            return fallback || key;
        }
        return result;
    }

    /**
     * Builds the panel's inner HTML.
     * @param {object} ctx Shared panel context (theme constants) assembled in ui-panel.js.
     * @returns {string} HTML string assigned to the panel element's innerHTML.
     */
    internal.buildPanelHtml = function(ctx) {
        const { panelBgColor, headerFooterBg, detailsBackground, primaryAccentColor,
                toggleAccentColor, kbdBackground, presetBoxBackground, githubButtonBg,
                releaseNotesBg, checkUpdatesBorder, releaseNotesTextColor, logoUrl } = ctx;

        const generatePresetHTML = (presets, type) => {
            let html = presets.map((preset, index) => {
                let previewStyle = '';
                if (type === 'style') {
                    previewStyle = `background-color: ${preset.bgColor}; color: ${preset.textColor}; border: 1px solid rgba(255,255,255,0.3); text-shadow: #000000 0px 0px 3px;`;
                } else if (type === 'font-size') {
                    previewStyle = `font-size: ${preset.size}em; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8);`;
                } else if (type === 'font-family') {
                    previewStyle = `font-family: ${preset.family}; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8); font-size: 1.5em;`;
                }
                return `
                    <div class="preset-box ${type}-preset" data-preset-index="${index}" title="${escapeHtml(preset.name)}" style="display: flex; justify-content: center; align-items: center; padding: 8px; border: 2px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.2s; background: ${presetBoxBackground}; min-height: 30px;" onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='${presetBoxBackground}'">
                        <span style="display: inline-block; ${type === 'style' ? `width: 40px; height: 25px; border-radius: 4px; line-height: 25px;` : ''} ${previewStyle} text-align: center; font-weight: bold;">${escapeHtml(preset.previewText)}</span>
                    </div>`;
            }).join('');
            return html;
        };

        const userShortcuts = (JE.userConfig.shortcuts.Shortcuts || []).reduce((acc, s) => {
            acc[s.Name] = s;
            return acc;
        }, {});

        return `
            <style>
                /* Adaptive settings view: section nav on the left, one pane at a
                   time on the right; below 760px the nav is the first screen and
                   the pane covers it instantly with a back button. */
                #jellyfin-enhanced-panel .je-panel-body { display: grid; grid-template-columns: 230px minmax(0, 1fr); flex: 1; min-height: 0; background: ${panelBgColor}; }
                #jellyfin-enhanced-panel .je-panel-nav { display: flex; flex-direction: column; gap: 10px; padding: 14px 12px; border-right: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.18); overflow-y: auto; }
                #jellyfin-enhanced-panel .je-panel-nav-items { display: flex; flex-direction: column; gap: 3px; }
                #jellyfin-enhanced-panel .je-panel-search { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; font-family: inherit; font-size: 13px; outline: none; }
                #jellyfin-enhanced-panel .je-panel-search:focus { border-color: ${primaryAccentColor}; }
                #jellyfin-enhanced-panel .tab-button { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: none; border-radius: 8px; background: transparent; color: rgba(255,255,255,0.65); font-family: inherit; font-size: 14px; font-weight: 600; text-align: left; cursor: pointer; transition: background-color 0.15s, color 0.15s; }
                #jellyfin-enhanced-panel .tab-button:hover { background: rgba(255,255,255,0.06); color: #fff; }
                #jellyfin-enhanced-panel .tab-button.active { background: rgba(255,255,255,0.08); color: #fff; }
                #jellyfin-enhanced-panel .tab-button.active::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 3px; background: ${primaryAccentColor}; }
                #jellyfin-enhanced-panel .je-panel-main { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 4px 20px 20px 20px; }
                #jellyfin-enhanced-panel .je-pane { display: none; }
                #jellyfin-enhanced-panel .je-pane.active { display: block; }
                #jellyfin-enhanced-panel .je-pane-title { display: flex; align-items: center; gap: 8px; margin: 14px 0 12px 0; font-size: 17px; font-weight: 700; color: #fff; font-family: inherit; }
                #jellyfin-enhanced-panel .je-pane-back { display: none; align-items: center; justify-content: center; margin: 12px 0 0 0; padding: 8px; border: none; border-radius: 50%; background: rgba(255,255,255,0.08); color: #fff; font-family: inherit; cursor: pointer; align-self: flex-start; }
                @media (max-width: 760px) {
                    #jellyfin-enhanced-panel { top: 0 !important; left: 0 !important; transform: none !important; width: 100vw !important; max-width: 100vw !important; height: 100dvh !important; max-height: 100dvh !important; border-radius: 0 !important; border: none !important; box-sizing: border-box !important; }
                    #jellyfin-enhanced-panel .je-panel-body { display: block; position: relative; overflow: hidden; }
                    #jellyfin-enhanced-panel .je-panel-nav { position: absolute; inset: 0; border-right: none; z-index: 1; }
                    /* The closed pane is parked off-screen by the transform alone —
                       deliberately untransitioned so opening a section swaps the
                       layer instantly instead of sliding it in. */
                    #jellyfin-enhanced-panel .je-panel-main { position: absolute; inset: 0; z-index: 2; background: rgb(24, 24, 24); transform: translateX(102%); }
                    #jellyfin-enhanced-panel .je-panel-body.je-pane-open .je-panel-main { transform: translateX(0); }
                    #jellyfin-enhanced-panel .je-panel-body.je-pane-open .je-pane-back { display: inline-flex; }
                }
                @keyframes shake { 10%, 90% { transform: translateX(-1px); } 20%, 80% { transform: translateX(2px); } 30%, 50%, 70% { transform: translateX(-4px); } 40%, 60% { transform: translateX(4px); } }
                .shake-error { animation: shake 0.5s ease-in-out; }
            </style>
            <div class="panel-header" style="position: relative; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); background: ${headerFooterBg}; display: flex; align-items: baseline; gap: 10px; cursor: grab;">
                <div style="font-size: 20px; font-weight: 700; background: ${primaryAccentColor}; -webkit-background-clip: text; -webkit-text-fill-color: transparent;">${JE.icon(JE.IconName.JELLYFISH)} Jellyfin Enhanced</div>
                <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${escapeHtml(JE.t('panel_version', { version: JE.pluginVersion }))}</div>
                <button id="closeSettingsPanel" style="position:absolute; top:50%; right:20px; transform:translateY(-50%); background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:16px; cursor:pointer; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">×</button>
            </div>
            <div class="je-panel-body">
                <nav class="je-panel-nav" aria-label="${escapeHtml(JE.t('panel_settings_tab'))}">
                    <input id="jePanelSearch" class="je-panel-search" type="text" placeholder="${escapeHtml(tWithFallback('panel_search_placeholder', 'Search settings…'))}" />
                    <div class="je-panel-nav-items"></div>
                </nav>
                <div class="je-panel-main">
                <button id="jePanelBack" class="je-pane-back" type="button"><span class="material-icons" style="font-size:16px;" aria-hidden="true">arrow_back</span></button>
                 ${!JE.pluginConfig.DisableAllShortcuts ? `
                 <div id="shortcuts-content" class="tab-content je-pane" data-pane="shortcuts" data-pane-label="${escapeHtml(JE.t('panel_shortcuts_tab'))}" style="padding-top: 4px; padding-bottom: 20px;">
                 <h3 class="je-pane-title">${JE.icon(JE.IconName.KEYBOARD)} ${JE.t('panel_shortcuts_tab')}</h3>
                 <div class="shortcuts-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 24px;">
                        <div>
                            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${primaryAccentColor}; font-family: inherit;">${JE.t('panel_shortcuts_global')}</h3>
                            <div style="display: grid; gap: 8px; font-size: 14px;">
                                ${(JE.pluginConfig.Shortcuts || []).filter((s, index, self) => s.Category === 'Global' && index === self.findIndex(t => t.Name === s.Name)).map(action => {
                                    const isDisabled = JE.state.activeShortcuts[action.Name] === '';
                                    return `
                                    <div style="display: flex; justify-content: space-between; align-items: center; ${isDisabled ? 'opacity: 0.5;' : ''}">
                                        <div style="display: flex; align-items: center; gap: 6px;">
                                            <span class="shortcut-key" tabindex="0" data-action="${escapeHtml(action.Name)}" style="background:${kbdBackground}; padding:2px 8px; border-radius:3px; cursor:pointer; transition: all 0.2s;">${escapeHtml(isDisabled ? tWithFallback('panel_shortcuts_disabled', 'Disabled') : (JE.state.activeShortcuts[action.Name] || ''))}</span>
                                            <button class="shortcut-toggle" data-action="${escapeHtml(action.Name)}" style="background:transparent; border:none; color:rgba(255,255,255,0.5); cursor:pointer; padding:2px; display:flex; align-items:center;">${JE.icon(JE.IconName.NO_ENTRY)}</button>
                                        </div>
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            ${userShortcuts.hasOwnProperty(action.Name) ? `<span title="Modified by user" class="modified-indicator" style="color:${primaryAccentColor}; font-size: 20px; line-height: 1;">•</span>` : ''}
                                            <span>${escapeHtml(tWithFallback('shortcut_' + action.Name, action.Label))}</span>
                                        </div>
                                    </div>
                                `;
                                }).join('')}
                            </div>
                        </div>
                        <div>
                            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${primaryAccentColor}; font-family: inherit;">${JE.t('panel_shortcuts_player')}</h3>
                            <div style="display: grid; gap: 8px; font-size: 14px;">
                                ${['CycleAspectRatio', 'ShowPlaybackInfo', 'SubtitleMenu', 'CycleSubtitleTracks', 'CycleAudioTracks', 'IncreasePlaybackSpeed', 'DecreasePlaybackSpeed', 'ResetPlaybackSpeed', 'BookmarkCurrentTime', 'OpenEpisodePreview', 'SkipIntroOutro', 'FrameStepBack', 'FrameStepForward', 'JumpToLastPosition', 'JumpToPercentage'].map(action => {
                                    const a = (JE.pluginConfig.Shortcuts || []).find(s => s.Name === action);
                                    const fallbackLabel = a?.Label || action;
                                    const isDisabled = JE.state.activeShortcuts[action] === '';
                                    const isReadonly = action === 'JumpToPercentage';
                                    return `
                                    <div style="display: flex; justify-content: space-between; align-items: center; ${isDisabled ? 'opacity: 0.5;' : ''}">
                                        <div style="display: flex; align-items: center; gap: 6px;">
                                            <span class="shortcut-key" ${isReadonly ? 'data-readonly="1"' : 'tabindex="0"'} data-action="${escapeHtml(action)}" style="background:${kbdBackground}; padding:2px 8px; border-radius:3px; ${isReadonly ? '' : 'cursor:pointer;'} transition: all 0.2s;">${escapeHtml(isDisabled ? tWithFallback('panel_shortcuts_disabled', 'Disabled') : (JE.state.activeShortcuts[action] || ''))}</span>
                                            <button class="shortcut-toggle" data-action="${escapeHtml(action)}" style="background:transparent; border:none; color:rgba(255,255,255,0.5); cursor:pointer; padding:2px; display:flex; align-items:center;">${JE.icon(JE.IconName.NO_ENTRY)}</button>
                                        </div>
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            ${userShortcuts.hasOwnProperty(action) ? `<span class="modified-indicator" title="Modified by user" style="color:${primaryAccentColor}; font-size: 20px; line-height: 1;">•</span>` : ''}
                                            <span>${escapeHtml(tWithFallback('shortcut_' + action, fallbackLabel))}${action === 'OpenEpisodePreview' ? ' <span style="font-size: 11px; opacity: 0.7;" title="Requires InPlayerEpisodePreview plugin from https://github.com/Namo2/InPlayerEpisodePreview/">ⓘ</span>' : ''}</span>
                                        </div>
                                    </div>
                                `;
                                }).join('')}
                            </div>
                        </div>
                    </div>
                    <div style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.6);">
                    ${JE.t('panel_shortcuts_footer')}
                    </div>
                </div>` : ''}
                <div id="settings-content" style="display: contents;">
                    <section class="je-pane" data-pane="playback">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.PLAYBACK)} ${JE.t('panel_settings_playback')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPauseToggle" ${JE.currentSettings.autoPauseEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_pause')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_pause_desc')}</div></div>
                                </label>
                            </div>
                           <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoResumeToggle" ${JE.currentSettings.autoResumeEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_resume')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_resume_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPipToggle" ${JE.currentSettings.autoPipEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_pip')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_pip_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="longPress2xEnabled" ${JE.currentSettings.longPress2xEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_long_press_2x_speed')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_long_press_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="pauseScreenToggle" ${JE.currentSettings.pauseScreenEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_custom_pause_screen')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_custom_pause_screen_desc')}</div></div>
                                </label>
                                <div class="je-pause-delay-row" style="margin-top:10px; display:flex; align-items:center; gap:8px; padding-left:30px;">
                                    <label for="pauseScreenDelayInput" style="font-size:12px; color:rgba(255,255,255,0.7); white-space:nowrap;">${JE.t('panel_settings_pause_screen_delay_label')}</label>
                                    <input type="number" id="pauseScreenDelayInput" min="1" max="60" value="${JE.currentSettings.pauseScreenDelaySeconds ?? 5}" style="width:60px; padding:4px 6px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:#fff; font-size:12px; text-align:center;">
                                </div>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="auto-skip">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.SKIP)} ${JE.t('panel_settings_auto_skip')}</h3>
                        <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-left: 18px; margin-bottom: 10px;">${JE.t('panel_settings_auto_skip_depends')}</div>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoSkipIntroToggle" ${JE.currentSettings.autoSkipIntro ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_skip_intro')}</div></div>
                                </label>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoSkipOutroToggle" ${JE.currentSettings.autoSkipOutro ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_skip_outro')}</div></div>
                                </label>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="subtitles">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.SUBTITLES)} ${JE.t('panel_settings_subtitles')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="disableCustomSubtitleStyles" ${JE.currentSettings.disableCustomSubtitleStyles ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_disable_custom_styles')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_disable_custom_styles_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JE.t('panel_settings_subtitles_style')}</div><div id="subtitle-style-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(JE.subtitlePresets, 'style')}</div></div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${primaryAccentColor};">
                                <div style="font-weight: 600; margin-bottom: 12px;">${JE.icon(JE.IconName.PAINT)}</div>
                                <div class="je-subtitle-color-layout" style="display: flex; gap: 12px;">
                                    <div class="je-subtitle-color-controls" style="flex: 1; display: flex; flex-direction: column; gap: 12px;">
                                        <div>
                                            <div style="font-size: 13px; margin-bottom: 6px; color: rgba(255,255,255,0.8);">Text</div>
                                            <div class="je-subtitle-color-control-row" style="display: flex; gap: 8px; align-items: center;">
                                                <input type="color" id="customSubtitleTextColorPicker" value="${JE.currentSettings.customSubtitleTextColor?.substring(0, 7) || '#FFFFFF'}" style="width: 50px; height: 36px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; background: transparent;">
                                                <input type="range" id="customSubtitleTextAlpha" min="0" max="255" value="${parseInt(JE.currentSettings.customSubtitleTextColor?.substring(7, 9) || 'FF', 16)}" style="flex: 1; accent-color: ${primaryAccentColor};">
                                            </div>
                                        </div>
                                        <div>
                                            <div style="font-size: 13px; margin-bottom: 6px; color: rgba(255,255,255,0.8);">Background</div>
                                            <div class="je-subtitle-color-control-row" style="display: flex; gap: 8px; align-items: center;">
                                                <input type="color" id="customSubtitleBgColorPicker" value="${JE.currentSettings.customSubtitleBgColor?.substring(0, 7) || '#000000'}" style="width: 50px; height: 36px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; background: transparent;">
                                                <input type="range" id="customSubtitleBgAlpha" min="0" max="255" value="${parseInt(JE.currentSettings.customSubtitleBgColor?.substring(7, 9) || '00', 16)}" style="flex: 1; accent-color: ${primaryAccentColor};">
                                            </div>
                                        </div>
                                    </div>
                                    <div id="subtitleColorPreview" style="display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 600; border-radius: 6px; background: rgba(0,0,0,0.3); color: ${JE.currentSettings.customSubtitleTextColor || '#FFFFFFFF'}; background-color: ${JE.currentSettings.customSubtitleBgColor || '#00000000'}; padding: 12px 20px; flex: 0.5; align-self: center;">AaBbCcDd</div>
                                </div>
                            </div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JE.t('panel_settings_subtitles_size')}</div><div id="font-size-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(JE.fontSizePresets, 'font-size')}</div></div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JE.t('panel_settings_subtitles_font')}</div><div id="font-family-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(JE.fontFamilyPresets, 'font-family')}</div></div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <span style="font-weight: 600;">${JE.t('panel_settings_subtitles_position')}</span>
                                    <button id="subtitlePositionReset" style="font-family:inherit; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.7); padding:3px 8px; border-radius:4px; font-size:11px; cursor:pointer; display:flex; align-items:center;"><span class="material-icons" style="font-size:16px;">restart_alt</span></button>
                                </div>
                                <div id="subtitlePositionGrid" style="position:relative; width:min(60vw,280px); height:min(34vw,158px); background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.15); border-radius:6px; cursor:crosshair; user-select:none; overflow:hidden; margin: 0 auto;">
                                    <!-- Crosshair guides -->
                                    <div style="position:absolute;inset:0;pointer-events:none;">
                                        <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.08);transform:translateX(-50%);"></div>
                                        <div style="position:absolute;top:50%;left:0;right:0;height:1px;background:rgba(255,255,255,0.08);transform:translateY(-50%);"></div>
                                    </div>
                                    <!-- Subtitle preview text -->
                                    <div id="subtitlePositionPreview" style="position:absolute; transform:translate(-50%,-50%); pointer-events:none; white-space:nowrap; font-size:clamp(8px,1.5vw,13px); font-weight:600; color:${JE.currentSettings.customSubtitleTextColor?.substring(0,7) || '#ffffff'}; background-color:${JE.currentSettings.customSubtitleBgColor || 'transparent'}; padding:2px 6px; border-radius:3px; text-shadow:0 0 4px #000; left:${JE.currentSettings.subtitleHorizontalPosition ?? 50}%; top:${JE.currentSettings.subtitleVerticalPosition ?? 85}%;">AaBbCcDd</div>
                                </div>
                                <div style="margin-top:6px; font-size:11px; color:rgba(255,255,255,0.4); text-align:center;">${JE.t('panel_settings_subtitles_position_note') || 'Requires Jellyfin subtitle style set to <b>Custom</b> in Subtitle settings'}</div>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="random-button">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.RANDOM)} ${JE.t('panel_settings_random_button')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomButtonToggle" ${JE.currentSettings.randomButtonEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><div><div style="font-weight:500;">${JE.t('panel_settings_random_button_enable')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_random_button_enable_desc')}</div></div></label>
                                <br>
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomUnwatchedOnly" ${JE.currentSettings.randomUnwatchedOnly ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><div><div style="font-weight:500;">${JE.t('panel_settings_random_button_unwatched')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_random_button_unwatched_desc')}</div></div></label>
                            </div>
                            <div style="font-weight:500; margin-bottom:8px;">${JE.t('panel_settings_random_button_types')}</div>
                            <div style="display:flex; gap:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeMovies" ${JE.currentSettings.randomIncludeMovies ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><span>${JE.t('panel_settings_random_button_movies')}</span></label>
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeShows" ${JE.currentSettings.randomIncludeShows ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><span>${JE.t('panel_settings_random_button_shows')}</span></label>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="ui">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.UI)} ${JE.t('panel_settings_ui')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showWatchProgressToggle" ${JE.currentSettings.showWatchProgress ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_watch_progress')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_watch_progress_desc')}</div></div>
                                </label>
                                <div style="display:flex; gap:12px; margin-top:10px;">
                                    <div style="flex:1;">
                                        <select id="watchProgressModeSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                                            <option value="percentage" ${JE.currentSettings.watchProgressMode === 'percentage' ? 'selected' : ''}>Percentage</option>
                                            <option value="time" ${JE.currentSettings.watchProgressMode === 'time' ? 'selected' : ''}>Time Watched</option>
                                            <option value="remaining" ${JE.currentSettings.watchProgressMode === 'remaining' ? 'selected' : ''}>Time Remaining</option>
                                        </select>
                                    </div>
                                    <div style="flex:1;">
                                        <select id="watchProgressTimeFormatSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                                            <option value="hours" ${JE.currentSettings.watchProgressTimeFormat === 'hours' ? 'selected' : ''}>h:m</option>
                                            <option value="full" ${JE.currentSettings.watchProgressTimeFormat === 'full' ? 'selected' : ''}>y:mo:d:h:m</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showFileSizesToggle" ${JE.currentSettings.showFileSizes ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_file_sizes')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_file_sizes_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showAudioLanguagesToggle" ${JE.currentSettings.showAudioLanguages ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_audio_languages')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_audio_languages_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="qualityTagsToggle" ${JE.currentSettings.qualityTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JE.t('panel_settings_ui_quality_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_quality_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="qualityTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                                <div id="qualityTagsSubWrap" class="je-quality-cat-wrap" style="display: ${JE.currentSettings.qualityTagsEnabled ? 'block' : 'none'};">
                                    <button type="button" id="qualityTagsSubToggleExpander" class="je-quality-cat-expander" aria-expanded="false">
                                        <span class="material-icons je-cat-chevron" aria-hidden="true">chevron_right</span>
                                        <span>${JE.t('panel_settings_ui_quality_tags_categories_label')}</span>
                                    </button>
                                </div>
                                <div id="qualityTagsSubToggles" class="je-quality-cat-list" style="display: none;">
                                    ${(() => {
                                        const cats = [
                                            { id: 'showResolutionTagToggle',    settingKey: 'showResolutionTag',    pluginKey: 'ShowResolutionTag',    orderKey: 'resolutionTagOrder',    orderPluginKey: 'ResolutionTagOrder',    defaultOrder: 1, labelKey: 'panel_settings_ui_quality_tags_resolution' },
                                            { id: 'showSourceTagToggle',        settingKey: 'showSourceTag',        pluginKey: 'ShowSourceTag',        orderKey: 'sourceTagOrder',        orderPluginKey: 'SourceTagOrder',        defaultOrder: 2, labelKey: 'panel_settings_ui_quality_tags_source' },
                                            { id: 'showDynamicRangeTagToggle',  settingKey: 'showDynamicRangeTag',  pluginKey: 'ShowDynamicRangeTag',  orderKey: 'dynamicRangeTagOrder',  orderPluginKey: 'DynamicRangeTagOrder',  defaultOrder: 3, labelKey: 'panel_settings_ui_quality_tags_dynamic_range' },
                                            { id: 'showSpecialFormatTagToggle', settingKey: 'showSpecialFormatTag', pluginKey: 'ShowSpecialFormatTag', orderKey: 'specialFormatTagOrder', orderPluginKey: 'SpecialFormatTagOrder', defaultOrder: 4, labelKey: 'panel_settings_ui_quality_tags_special_format' },
                                            { id: 'showVideoCodecTagToggle',    settingKey: 'showVideoCodecTag',    pluginKey: 'ShowVideoCodecTag',    orderKey: 'videoCodecTagOrder',    orderPluginKey: 'VideoCodecTagOrder',    defaultOrder: 5, labelKey: 'panel_settings_ui_quality_tags_video_codec' },
                                            { id: 'showAudioInfoTagToggle',     settingKey: 'showAudioInfoTag',     pluginKey: 'ShowAudioInfoTag',     orderKey: 'audioInfoTagOrder',     orderPluginKey: 'AudioInfoTagOrder',     defaultOrder: 6, labelKey: 'panel_settings_ui_quality_tags_audio_info' },
                                        ];
                                        // Resolve to the effective enable/order (user override → admin default → hardcoded)
                                        // so the panel reflects what's actually rendering, even when the user has
                                        // never customized and inherits the admin value.
                                        const effEnable = (c) => {
                                            const u = JE.currentSettings[c.settingKey];
                                            if (typeof u === 'boolean') return u;
                                            const a = JE.pluginConfig?.[c.pluginKey];
                                            return typeof a === 'boolean' ? a : true;
                                        };
                                        const effOrder = (c) => {
                                            const u = JE.currentSettings[c.orderKey];
                                            if (Number.isFinite(u)) return u;
                                            const a = JE.pluginConfig?.[c.orderPluginKey];
                                            return Number.isFinite(a) ? a : c.defaultOrder;
                                        };
                                        const sorted = cats.slice().sort((a, b) => {
                                            const ao = effOrder(a);
                                            const bo = effOrder(b);
                                            if (ao !== bo) return ao - bo;
                                            return a.defaultOrder - b.defaultOrder;
                                        });
                                        return sorted.map((c, idx) => {
                                            const checked = effEnable(c) ? 'checked' : '';
                                            const upDisabled = idx === 0 ? 'disabled' : '';
                                            const downDisabled = idx === sorted.length - 1 ? 'disabled' : '';
                                            return `
                                                <div class="je-quality-cat-row" data-cat-key="${c.settingKey}" data-order-key="${c.orderKey}" data-default-order="${c.defaultOrder}">
                                                    <label class="je-quality-cat-label-wrap">
                                                        <input type="checkbox" id="${c.id}" ${checked} style="accent-color:${toggleAccentColor};">
                                                        <span class="je-quality-cat-label">${JE.t(c.labelKey)}</span>
                                                    </label>
                                                    <button type="button" class="je-cat-btn je-cat-up" ${upDisabled} aria-label="${JE.t('panel_settings_ui_quality_tags_move_up')}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                                                    <button type="button" class="je-cat-btn je-cat-down" ${downDisabled} aria-label="${JE.t('panel_settings_ui_quality_tags_move_down')}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
                                                </div>
                                            `;
                                        }).join('');
                                    })()}
                                </div>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="genreTagsToggle" ${JE.currentSettings.genreTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JE.t('panel_settings_ui_genre_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_genre_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="genreTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="languageTagsToggle" ${JE.currentSettings.languageTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JE.t('panel_settings_ui_language_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_language_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="languageTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                            </div>
                                <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                        <div style="display: flex; align-items: center; gap: 12px;">
                                            <input type="checkbox" id="ratingTagsToggle" ${JE.currentSettings.ratingTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                            <div><div style="font-weight:500;">${JE.t('panel_settings_ui_rating_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_rating_tags_desc')}</div></div>
                                        </div>
                                        <div class="position-selector" data-setting="ratingTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                            <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        </div>
                                    </label>
                                </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="peopleTagsToggle" ${JE.currentSettings.peopleTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_people_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_people_tags_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="tagsHideOnHoverToggle" ${JE.currentSettings.tagsHideOnHover ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_hide_tags_on_hover')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_hide_tags_on_hover_desc')}</div></div>
                                </label>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="removeContinueWatchingToggle" ${JE.currentSettings.removeContinueWatchingEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_remove_continue_watching')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_remove_continue_watching_desc')}</div></div>
                                </label>
                            </div>
                        </div>
                    </section>
                    ${/* Hidden Content settings — only rendered when the module is initialized (controlled by HiddenContentEnabled config) */ ''}
                    ${JE.hiddenContent ? `<section class="je-pane" data-pane="hidden-content">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.EYE)} ${JE.t('hidden_content_settings_title')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenContentEnabledToggle" ${JE.hiddenContent?.getSettings()?.enabled !== false ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('hidden_content_toggle_label')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('hidden_content_toggle_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenShowHideButtons" ${JE.hiddenContent?.getSettings()?.showHideButtons !== false ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('hidden_content_show_buttons_label')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('hidden_content_show_buttons_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenShowConfirmation" ${JE.hiddenContent?.getSettings()?.showHideConfirmation !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_confirm_toggle_label')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_confirm_toggle_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px;">
                                <div style="font-weight:500; font-size:13px; color:rgba(255,255,255,0.7); margin-bottom:8px; padding-left:4px;">${JE.t('hidden_content_button_section_title')}</div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonJellyseerr" ${JE.hiddenContent?.getSettings()?.showButtonJellyseerr !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_show_button_jellyseerr')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_show_button_jellyseerr_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonLibrary" ${JE.hiddenContent?.getSettings()?.showButtonLibrary ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_show_button_library')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_show_button_library_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonDetails" ${JE.hiddenContent?.getSettings()?.showButtonDetails !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_show_button_details')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_show_button_details_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonCast" ${JE.hiddenContent?.getSettings()?.showButtonCast ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_show_button_cast')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_show_button_cast_desc')}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div id="hiddenContentSurfaceToggles" style="margin-bottom: 12px;">
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterLibrary" ${JE.hiddenContent?.getSettings()?.filterLibrary !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_library')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_library_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterDiscovery" ${JE.hiddenContent?.getSettings()?.filterDiscovery !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_discovery')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_discovery_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterSearch" ${JE.hiddenContent?.getSettings()?.filterSearch !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_search')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_search_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterCalendar" ${JE.hiddenContent?.getSettings()?.filterCalendar !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_calendar')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_calendar_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterUpcoming" ${JE.hiddenContent?.getSettings()?.filterUpcoming !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_upcoming')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_upcoming_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterRecommendations" ${JE.hiddenContent?.getSettings()?.filterRecommendations !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_recommendations')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_recommendations_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterRequests" ${JE.hiddenContent?.getSettings()?.filterRequests !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_requests')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_requests_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterNextUp" ${JE.hiddenContent?.getSettings()?.filterNextUp !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_nextup')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_nextup_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterContinueWatching" ${JE.hiddenContent?.getSettings()?.filterContinueWatching !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_filter_continue')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_filter_continue_desc')}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255, 180, 50, 0.6);">
                                <div style="font-weight:500; font-size:13px; color:rgba(255, 180, 50, 0.9); margin-bottom:8px; padding-left:4px;">${JE.t('hidden_content_experimental_label')}</div>
                                <div style="padding: 12px; background: rgba(255, 180, 50, 0.05); border-radius: 6px; border-left: 3px solid rgba(255, 180, 50, 0.3);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenExperimentalCollections" ${JE.hiddenContent?.getSettings()?.experimentalHideCollections ? 'checked' : ''} style="width:16px; height:16px; accent-color:rgba(255, 180, 50, 0.8); cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JE.t('hidden_content_experimental_collections')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JE.t('hidden_content_experimental_collections_desc')}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <button id="manageHiddenContentBtn" style="width: 100%; padding: 12px; background: ${toggleAccentColor}; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
                                    ${JE.t('hidden_content_manage_button')} (${JE.hiddenContent?.getHiddenCount() || 0})
                                </button>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${JE.t('hidden_content_manage_desc')}</div>
                            </div>
                        </div>
                    </section>` : ''}
                    ${JE.internals.spoilerGuard?.buildSettingsHtml?.(ctx) || ''}
                    <section class="je-pane" data-pane="language">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.LANGUAGE)} ${JE.t('panel_settings_language')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px;">
                                <div style="font-weight: 600; margin-bottom: 8px;">${JE.t('panel_settings_language_display')}</div>
                                <select id="displayLanguageSelect" style="width: 100%; padding: 12px; background: ${presetBoxBackground}; color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; font-size: 14px; cursor: pointer; font-family: inherit;">
                                    <option value="" style="background: rgba(30,30,30,1); color: #fff;">Auto</option>
                                    <!-- Languages will be populated dynamically -->
                                </select>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${JE.t('panel_settings_language_display_desc')}</div>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <button id="clearTranslationCacheButton" style="width: 100%; padding: 12px; background: ${toggleAccentColor}; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
                                    ${JE.t('panel_settings_language_clear_cache')}
                                </button>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${JE.t('panel_settings_language_clear_cache_desc')}</div>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="about">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.QUESTION)} ${escapeHtml(tWithFallback('panel_about_title', 'About'))}</h3>
                        <div style="padding: 4px 0 16px 0; display: flex; flex-direction: column; gap: 14px;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="font-size: 28px; line-height: 1;">${JE.icon(JE.IconName.JELLYFISH)}</div>
                                <div>
                                    <div style="font-weight: 700; font-size: 16px;">Jellyfin Enhanced</div>
                                    <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${escapeHtml(JE.t('panel_version', { version: JE.pluginVersion }))}</div>
                                </div>
                            </div>
                            <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                                <button id="releaseNotesBtn" style="font-family:inherit; background:${releaseNotesBg}; color:${releaseNotesTextColor}; border:${checkUpdatesBorder}; padding:8px 14px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; gap:6px;" onmouseover="this.style.background='${primaryAccentColor}'" onmouseout="this.style.background='${releaseNotesBg}'">${JE.t('panel_footer_release_notes')}</button>
                                <a href="https://github.com/${GITHUB_REPO}/" target="_blank" style="color:${primaryAccentColor}; text-decoration:none; display:flex; align-items:center; gap:6px; font-size:13px; padding:8px 12px; border-radius:8px; background:${githubButtonBg}; transition:background 0.2s;" onmouseover="this.style.background='rgba(102, 179, 255, 0.2)'" onmouseout="this.style.background='${githubButtonBg}'"><svg height="13" viewBox="0 0 24 24" width="13" fill="currentColor"><path d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.193 10.193 0 0 1 2.75-.371c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z"></path></svg> ${JE.t('panel_footer_contribute')}</a>
                            </div>
                            ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" class="footer-logo" alt="Theme Logo" style="height: 40px; align-self: flex-start;">` : ''}
                        </div>
                    </section>
                </div>
                </div>
            </div>
            <div class="panel-footer" style="padding: 10px 20px; border-top: 1px solid rgba(255,255,255,0.1); background: ${headerFooterBg}; display: flex; justify-content: center; align-items: center;">
                <div class="close-helptext" style="font-size:12px; color:rgba(255,255,255,0.5);">${JE.t('panel_footer_close')}</div>
            </div>
        `;
    };

})(window.JellyfinEnhanced);

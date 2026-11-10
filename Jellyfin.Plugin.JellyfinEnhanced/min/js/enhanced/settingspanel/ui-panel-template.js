(() => {
"use strict";(()=>{function B(e,i,a){let c=i.core?.featureContext;if(typeof c!="function")throw new Error(`${e}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return c(e,i,a)}function _(){let e=window;if(!e.JellyfinEnhanced)throw new TypeError("Jellyfin Enhanced must load before the settings panel");return e.JellyfinEnhanced}function H(e){return B("settings-panel",e,{internalSlots:["enhancedUi"],internalsObject:()=>e.internals=e.internals||{}})}function V(e){return e.internals=e.internals||{},e.internals.enhancedUi=e.internals.enhancedUi||{}}function Q(e){if(typeof e=="number")return Number.isInteger(e)&&e>=0?e:void 0;if(typeof e=="string"&&e!==""&&String(Number(e))===e){let i=Number(e);return Number.isInteger(i)&&i>=0?i:void 0}}function w(e,i,a){let c=Q(i??a);return c===void 0?void 0:e[c]}function D(e,i){let a=e??i;return typeof a=="number"?a:Number(a)}function S(e){if(typeof e!="string")return!1;let i=e.trim();return/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+|(?:rgba?|hsla?)\([\d\s.,%/+-]*\))$/i.test(i)?typeof CSS>"u"||typeof CSS.supports!="function"||CSS.supports("color",i):!1}function M(e){return typeof e=="string"&&/^[\w\s,.'-]+$/.test(e)&&(e.split("'").length-1)%2===0}var U=["CycleAspectRatio","ShowPlaybackInfo","SubtitleMenu","CycleSubtitleTracks","CycleAudioTracks","IncreasePlaybackSpeed","DecreasePlaybackSpeed","ResetPlaybackSpeed","BookmarkCurrentTime","OpenEpisodePreview","SkipIntroOutro","FrameStepBack","FrameStepForward","DecreaseSubtitleOffset","IncreaseSubtitleOffset","JumpToLastPosition","JumpToPercentage"];function G(e){if(!Array.isArray(e))return[];let i=[];for(let a of e){if(a===null||typeof a!="object"||Array.isArray(a))continue;let c=a.Name;if(typeof c!="string")continue;let o=a.Key;i.push({...a,Name:c,Key:typeof o=="string"?o:""})}return i}function $(e,i){if(e===void 0)throw new TypeError(`Missing ${i}`);return e}function Z(e,i=H(e)){let a=V(e),{GITHUB_REPO:c}=a,o=e.escapeHtml,k=new Set;function g(p,b){let u;try{u=e.t(p)}catch(f){console.warn(`🪼 Jellyfin Enhanced: JE.t('${p}') threw, using fallback:`,f),u=null}return!u||u===p?(k.has(p)||(k.add(p),console.warn(`🪼 Jellyfin Enhanced: missing translation key '${p}', using inline fallback`)),b?String(b):p):u}a.buildPanelHtml=function(p){let{panelBgColor:b,headerFooterBg:u,detailsBackground:f,primaryAccentColor:l,toggleAccentColor:t,kbdBackground:C,presetBoxBackground:n,githubButtonBg:P,releaseNotesBg:T,checkUpdatesBorder:K,releaseNotesTextColor:Y,logoUrl:z}=p,h=(r,d)=>r.map((s,y)=>{let x="";return d==="style"&&"bgColor"in s?x=`background-color: ${s.bgColor}; color: ${s.textColor}; border: 1px solid rgba(255,255,255,0.3); text-shadow: #000000 0px 0px 3px;`:d==="font-size"&&"size"in s?x=`font-size: ${s.size}em; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8);`:d==="font-family"&&"family"in s?x=`font-family: ${s.family}; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8); font-size: 1.5em;`:d==="text-effect"&&(x=`color: #fff; font-size: 1.5em; background-color: #8a8a8a; padding: 0 8px; border-radius: 4px; text-shadow: ${e.getSubtitleTextShadow("transparent",y)};`),`
                    <div class="preset-box ${d}-preset" data-preset-index="${y}" title="${o(s.name)}" style="display: flex; justify-content: center; align-items: center; padding: 8px; border: 2px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.2s; background: ${n}; min-height: 30px;" onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='${n}'">
                        <span style="display: inline-block; ${d==="style"?"width: 40px; height: 25px; border-radius: 4px; line-height: 25px;":""} ${x} text-align: center; font-weight: bold;">${o(s.previewText)}</span>
                    </div>`}).join(""),j=$(e.fontSizePresets[2],"the Normal subtitle size preset"),W=$(w(e.fontSizePresets,e.currentSettings.selectedFontSizePresetIndex,2)||j,"a subtitle size preset"),A=$(w(e.fontFamilyPresets,e.currentSettings.selectedFontFamilyPresetIndex,0)||e.fontFamilyPresets[0],"a subtitle font preset"),q=Math.max(8,Math.min(22,13*(W.size/j.size))),F=e.decodeSubtitleColor(e.currentSettings.customSubtitleTextColor,{fallbackSwatch:"#FFFFFF",fallbackAlphaValue:255}),R=e.decodeSubtitleColor(e.currentSettings.customSubtitleBgColor,{fallbackSwatch:"#000000",fallbackAlphaValue:0}),L=S(e.currentSettings.customSubtitleTextColor)?e.currentSettings.customSubtitleTextColor:"#FFFFFFFF",v=S(e.currentSettings.customSubtitleBgColor)?e.currentSettings.customSubtitleBgColor:"",X=M(A.family)?A.family:"inherit",O=e.getSubtitleTextShadow(v||"#00000000"),I=new Set((e.userConfig.shortcuts.Shortcuts||[]).map(r=>r.Name)),N=G(e.pluginConfig.Shortcuts);return`
            <style>
                /* Adaptive settings view: section nav on the left, one pane at a
                   time on the right; below 760px the nav is the first screen and
                   the pane covers it instantly with a back button. */
                #jellyfin-enhanced-panel .je-panel-body { display: grid; grid-template-columns: clamp(230px, 18%, 280px) minmax(0, 1fr); flex: 1; min-height: 0; background: ${b}; }
                #jellyfin-enhanced-panel .je-panel-nav { display: flex; flex-direction: column; gap: 10px; padding: 14px 12px; border-right: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.18); overflow-y: auto; }
                #jellyfin-enhanced-panel .je-panel-nav-items { display: flex; flex-direction: column; gap: 3px; }
                #jellyfin-enhanced-panel .je-panel-search { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; font-family: inherit; font-size: 13px; outline: none; }
                #jellyfin-enhanced-panel .je-panel-search:focus { border-color: ${l}; }
                #jellyfin-enhanced-panel:focus { outline: none; }
                #jellyfin-enhanced-panel .je-panel-search-results { list-style: none; margin: 0; padding: 4px; display: flex; flex-direction: column; gap: 2px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.3); max-height: 50%; overflow-y: auto; flex-shrink: 0; }
                #jellyfin-enhanced-panel .je-panel-search-results[hidden] { display: none; }
                #jellyfin-enhanced-panel .je-panel-search-result { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; min-height: 40px; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: #fff; font-family: inherit; font-size: 13px; font-weight: 600; text-align: left; cursor: pointer; }
                #jellyfin-enhanced-panel .je-panel-search-result:hover, #jellyfin-enhanced-panel .je-panel-search-result:focus-visible { background: rgba(255,255,255,0.1); outline: none; box-shadow: inset 0 0 0 2px ${l}; }
                #jellyfin-enhanced-panel .je-panel-search-result span { font-size: 11px; font-weight: 400; color: rgba(255,255,255,0.6); }
                #jellyfin-enhanced-panel .tab-button { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: none; border-radius: 8px; background: transparent; color: rgba(255,255,255,0.65); font-family: inherit; font-size: 14px; font-weight: 600; text-align: left; cursor: pointer; transition: background-color 0.15s, color 0.15s; }
                #jellyfin-enhanced-panel .tab-button:hover { background: rgba(255,255,255,0.06); color: #fff; }
                #jellyfin-enhanced-panel .tab-button.active { background: rgba(255,255,255,0.08); color: #fff; }
                #jellyfin-enhanced-panel .tab-button.active::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 3px; background: ${l}; }
                #jellyfin-enhanced-panel .je-panel-main { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 4px 20px 20px 20px; }
                #jellyfin-enhanced-panel .je-pane { display: none; }
                #jellyfin-enhanced-panel .je-pane.active { display: block; }
                #jellyfin-enhanced-panel .je-pane-title { display: flex; align-items: center; gap: 8px; margin: 14px 0 12px 0; font-size: 17px; font-weight: 700; color: #fff; font-family: inherit; }
                #jellyfin-enhanced-panel .je-pane-back { display: none; align-items: center; justify-content: center; margin: 12px 0 0 0; padding: 8px; border: none; border-radius: 50%; background: rgba(255,255,255,0.08); color: #fff; font-family: inherit; cursor: pointer; align-self: flex-start; }
                #jellyfin-enhanced-panel .je-pane-back:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
                #jellyfin-enhanced-panel .je-panel-dock { display: none; }
                @media (max-width: 760px) {
                    #jellyfin-enhanced-panel .je-panel-dock { position: relative; display: flex; flex: 0 0 auto; gap: 8px; padding: 8px 12px; background: ${b}; z-index: 3; }
                    #jellyfin-enhanced-panel .je-panel-dock select { width: 40%; min-width: 0; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; background: rgb(24,24,24); color: #fff; font: inherit; font-size: 13px; }
                    #jellyfin-enhanced-panel .je-panel-dock .je-panel-search { flex: 1; min-width: 0; width: 0; }
                    #jellyfin-enhanced-panel .je-panel-dock .je-panel-search-results { position: absolute; top: 100%; left: 12px; right: 12px; max-height: 45dvh; background: rgb(24,24,24); }

                    #jellyfin-enhanced-panel { top: 0 !important; left: 0 !important; transform: none !important; width: 100vw !important; max-width: 100vw !important; height: 100dvh !important; max-height: 100dvh !important; border-radius: 0 !important; border: none !important; box-sizing: border-box !important; }
                    #jellyfin-enhanced-panel .je-panel-body { display: block; position: relative; overflow: clip; }
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
            <div class="panel-header" style="position: relative; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); background: ${u}; display: flex; align-items: baseline; gap: 10px; cursor: grab;">
                <div id="jePanelTitle" style="font-size: 20px; font-weight: 700; background: ${l}; -webkit-background-clip: text; -webkit-text-fill-color: transparent;">${e.icon(e.IconName.JELLYFISH)} Jellyfin Enhanced</div>
                <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${o(e.t("panel_version",{version:String(e.pluginVersion)}))}</div>
                ${a.buildPanelSizeControlsHtml?a.buildPanelSizeControlsHtml():""}
                <button id="closeSettingsPanel" type="button" aria-label="${o(g("awards_close","Close"))}" style="position:absolute; top:50%; right:20px; transform:translateY(-50%); background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:16px; cursor:pointer; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">×</button>
            </div>
            <div class="je-panel-dock"><select id="jePanelSection" aria-label="${o(e.t("panel_settings_tab"))}"></select></div>
            <div class="je-panel-body">
                <nav class="je-panel-nav" aria-label="${o(e.t("panel_settings_tab"))}">
                    <input id="jePanelSearch" class="je-panel-search" type="search" placeholder="${o(g("panel_search_placeholder","Search settings…"))}" aria-label="${o(g("panel_search_placeholder","Search settings…"))}" aria-controls="jePanelSearchResults" />
                    <ul id="jePanelSearchResults" class="je-panel-search-results" aria-label="${o(g("panel_search_results","Matching settings"))}" hidden></ul>
                    <div class="je-panel-nav-items"></div>
                </nav>
                <div class="je-panel-main">
                <button id="jePanelBack" class="je-pane-back" type="button" aria-label="${o(g("panel_back_to_sections","Back to settings sections"))}"><span class="material-icons" style="font-size:16px;" aria-hidden="true">arrow_back</span></button>
                 ${e.pluginConfig.DisableAllShortcuts?"":`
                 <div id="shortcuts-content" class="tab-content je-pane" data-pane="shortcuts" data-pane-label="${o(e.t("panel_shortcuts_tab"))}" style="padding-top: 4px; padding-bottom: 20px;">
                 <h3 class="je-pane-title">${e.icon(e.IconName.KEYBOARD)} ${e.t("panel_shortcuts_tab")}</h3>
                 <div class="shortcuts-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 24px;">
                        <div>
                            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${l}; font-family: inherit;">${e.t("panel_shortcuts_global")}</h3>
                            <div style="display: grid; gap: 8px; font-size: 14px;">
                                ${N.filter((r,d,m)=>r.Category==="Global"&&d===m.findIndex(s=>s.Name===r.Name)).map(r=>{let d=e.state.activeShortcuts[r.Name]==="";return`
                                    <div style="display: flex; justify-content: space-between; align-items: center; ${d?"opacity: 0.5;":""}">
                                        <div style="display: flex; align-items: center; gap: 6px;">
                                            <span class="shortcut-key" tabindex="0" data-action="${o(r.Name)}" style="background:${C}; padding:2px 8px; border-radius:3px; cursor:pointer; transition: all 0.2s;">${o(d?g("panel_shortcuts_disabled","Disabled"):e.state.activeShortcuts[r.Name]||"")}</span>
                                            <button class="shortcut-toggle" data-action="${o(r.Name)}" style="background:transparent; border:none; color:rgba(255,255,255,0.5); cursor:pointer; padding:2px; display:flex; align-items:center;">${e.icon(e.IconName.NO_ENTRY)}</button>
                                        </div>
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            ${I.has(r.Name)?`<span title="Modified by user" class="modified-indicator" style="color:${l}; font-size: 20px; line-height: 1;">•</span>`:""}
                                            <span>${o(g("shortcut_"+r.Name,r.Label))}</span>
                                        </div>
                                    </div>
                                `}).join("")}
                            </div>
                        </div>
                        <div>
                            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${l}; font-family: inherit;">${e.t("panel_shortcuts_player")}</h3>
                            <div style="display: grid; gap: 8px; font-size: 14px;">
                                ${U.map(r=>{let m=N.find(x=>x.Name===r)?.Label||r,s=e.state.activeShortcuts[r]==="",y=r==="JumpToPercentage";return`
                                    <div style="display: flex; justify-content: space-between; align-items: center; ${s?"opacity: 0.5;":""}">
                                        <div style="display: flex; align-items: center; gap: 6px;">
                                            <span class="shortcut-key" ${y?'data-readonly="1"':'tabindex="0"'} data-action="${o(r)}" style="background:${C}; padding:2px 8px; border-radius:3px; ${y?"":"cursor:pointer;"} transition: all 0.2s;">${o(s?g("panel_shortcuts_disabled","Disabled"):e.state.activeShortcuts[r]||"")}</span>
                                            <button class="shortcut-toggle" data-action="${o(r)}" style="background:transparent; border:none; color:rgba(255,255,255,0.5); cursor:pointer; padding:2px; display:flex; align-items:center;">${e.icon(e.IconName.NO_ENTRY)}</button>
                                        </div>
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            ${I.has(r)?`<span class="modified-indicator" title="Modified by user" style="color:${l}; font-size: 20px; line-height: 1;">•</span>`:""}
                                            <span>${o(g("shortcut_"+r,m))}${r==="OpenEpisodePreview"?' <span style="font-size: 11px; opacity: 0.7;" title="Requires InPlayerEpisodePreview plugin from https://github.com/Namo2/InPlayerEpisodePreview/">'+e.icons.wrapEmoji("ⓘ")+"</span>":""}</span>
                                        </div>
                                    </div>
                                `}).join("")}
                            </div>
                        </div>
                    </div>
                    <div style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.6);">
                    ${e.t("panel_shortcuts_footer")}
                    </div>
                </div>`}
                <div id="settings-content" style="display: contents;">
                    <section class="je-pane" data-pane="playback">
                        <h3 class="je-pane-title">${e.icon(e.IconName.PLAYBACK)} ${e.t("panel_settings_playback")}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPauseToggle" ${e.currentSettings.autoPauseEnabled?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_auto_pause")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_auto_pause_desc")}</div></div>
                                </label>
                            </div>
                           <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoResumeToggle" ${e.currentSettings.autoResumeEnabled?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_auto_resume")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_auto_resume_desc")}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPipToggle" ${e.currentSettings.autoPipEnabled?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_auto_pip")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_auto_pip_desc")}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="longPress2xEnabled" ${e.currentSettings.longPress2xEnabled?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_long_press_2x_speed")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_long_press_desc")}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="pauseScreenToggle" ${e.currentSettings.pauseScreenEnabled?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_custom_pause_screen")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_custom_pause_screen_desc")}</div></div>
                                </label>
                                <div class="je-pause-delay-row" style="margin-top:10px; display:flex; align-items:center; gap:8px; padding-left:30px;">
                                    <label for="pauseScreenDelayInput" style="font-size:12px; color:rgba(255,255,255,0.7); white-space:nowrap;">${e.t("panel_settings_pause_screen_delay_label")}</label>
                                    <input type="number" id="pauseScreenDelayInput" min="1" max="60" value="${e.currentSettings.pauseScreenDelaySeconds??5}" style="width:60px; padding:4px 6px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:#fff; font-size:12px; text-align:center;">
                                </div>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="auto-skip">
                        <h3 class="je-pane-title">${e.icon(e.IconName.SKIP)} ${e.t("panel_settings_auto_skip")}</h3>
                        <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-left: 18px; margin-bottom: 10px;">${e.t("panel_settings_auto_skip_depends")}</div>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoSkipIntroToggle" ${e.currentSettings.autoSkipIntro?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_auto_skip_intro")}</div></div>
                                </label>
                            </div>
                            <div style="padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoSkipOutroToggle" ${e.currentSettings.autoSkipOutro?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_auto_skip_outro")}</div></div>
                                </label>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="subtitles">
                        <h3 class="je-pane-title">${e.icon(e.IconName.SUBTITLES)} ${e.t("panel_settings_subtitles")}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="disableCustomSubtitleStyles" ${e.currentSettings.disableCustomSubtitleStyles?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_disable_custom_styles")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_disable_custom_styles_desc")}</div></div>
                                </label>
                            </div>
                            <div id="je-subtitle-format-warning" style="display:none; margin-bottom: 16px; padding: 10px 12px; background: rgba(102,179,255,0.1); border: 1px solid rgba(102,179,255,0.3); border-radius: 6px; font-size: 12px; color: rgba(255,255,255,0.8); align-items: flex-start; gap: 8px;">
                                <span class="material-icons" style="font-size:16px; line-height:1.4;">info</span>
                                <span>${e.t("panel_settings_subtitles_format_warning")}</span>
                            </div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${e.t("panel_settings_subtitles_style")}</div><div id="subtitle-style-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${h(e.subtitlePresets,"style")}</div></div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${l};">
                                <div style="font-weight: 600; margin-bottom: 12px;">${e.icon(e.IconName.PAINT)}</div>
                                <div class="je-subtitle-color-layout" style="display: flex; gap: 12px;">
                                    <div class="je-subtitle-color-controls" style="flex: 1; display: flex; flex-direction: column; gap: 12px;">
                                        <div>
                                            <div style="font-size: 13px; margin-bottom: 6px; color: rgba(255,255,255,0.8);">Text</div>
                                            <div class="je-subtitle-color-control-row" style="display: flex; gap: 8px; align-items: center;">
                                                <input type="color" id="customSubtitleTextColorPicker" value="${F.swatch}" style="width: 50px; height: 36px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; background: transparent;">
                                                <input type="range" id="customSubtitleTextAlpha" min="0" max="255" value="${F.alphaValue}" style="flex: 1; accent-color: ${l};">
                                            </div>
                                        </div>
                                        <div>
                                            <div style="font-size: 13px; margin-bottom: 6px; color: rgba(255,255,255,0.8);">Background</div>
                                            <div class="je-subtitle-color-control-row" style="display: flex; gap: 8px; align-items: center;">
                                                <input type="color" id="customSubtitleBgColorPicker" value="${R.swatch}" style="width: 50px; height: 36px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; background: transparent;">
                                                <input type="range" id="customSubtitleBgAlpha" min="0" max="255" value="${R.alphaValue}" style="flex: 1; accent-color: ${l};">
                                            </div>
                                        </div>
                                    </div>
                                    <div id="subtitleColorPreview" style="display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 600; border-radius: 6px; background: rgba(0,0,0,0.3); color: ${L}; background-color: ${v||"#00000000"}; text-shadow: ${O}; padding: 12px 20px; flex: 0.5; align-self: center;">AaBbCcDd</div>
                                </div>
                            </div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${e.t("panel_settings_subtitles_size")}</div><div id="font-size-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${h(e.fontSizePresets,"font-size")}</div></div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${e.t("panel_settings_subtitles_font")}</div><div id="font-family-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${h(e.fontFamilyPresets,"font-family")}</div></div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${e.t("panel_settings_subtitles_text_effect")}</div><div id="text-effect-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${h(e.subtitleTextEffectPresets,"text-effect")}</div></div>
                            <div style="padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <span style="font-weight: 600;">${e.t("panel_settings_subtitles_position")}</span>
                                    <button id="subtitlePositionReset" style="font-family:inherit; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.7); padding:3px 8px; border-radius:4px; font-size:11px; cursor:pointer; display:flex; align-items:center;"><span class="material-icons" style="font-size:16px;">restart_alt</span></button>
                                </div>
                                <div id="subtitlePositionGrid" style="position:relative; width:min(60vw,280px); height:min(34vw,158px); background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.15); border-radius:6px; cursor:crosshair; user-select:none; overflow:hidden; margin: 0 auto;">
                                    <!-- Crosshair guides -->
                                    <div style="position:absolute;inset:0;pointer-events:none;">
                                        <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.08);transform:translateX(-50%);"></div>
                                        <div style="position:absolute;top:50%;left:0;right:0;height:1px;background:rgba(255,255,255,0.08);transform:translateY(-50%);"></div>
                                    </div>
                                    <!-- Subtitle preview text -->
                                    <div id="subtitlePositionPreview" style="position:absolute; transform:translateX(-50%); pointer-events:none; white-space:nowrap; font-size:${q}px; font-family:${X}; font-weight:600; color:${L}; background-color:${v||"transparent"}; padding:2px 6px; border-radius:3px; text-shadow:${O}; left:${e.currentSettings.subtitleHorizontalPosition??50}%; bottom:${100-D(e.currentSettings.subtitleVerticalPosition,95)}%; top:auto;">AaBbCcDd</div>
                                </div>
                                <div id="je-subtitle-position-note" style="display:none; margin-top:6px; font-size:11px; color:#ffcf5c; text-align:center; align-items:center; justify-content:center; gap:4px;">
                                    <span class="material-icons" style="font-size:13px;">warning</span>
                                    <span>${e.t("panel_settings_subtitles_position_note")||"Requires Jellyfin subtitle style set to <b>Custom</b> in Subtitle settings"}</span>
                                </div>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="random-button">
                        <h3 class="je-pane-title">${e.icon(e.IconName.RANDOM)} ${e.t("panel_settings_random_button")}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom:16px; padding:12px; background:${n}; border-radius:6px; border-left:3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomButtonToggle" ${e.currentSettings.randomButtonEnabled?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;"><div><div style="font-weight:500;">${e.t("panel_settings_random_button_enable")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_random_button_enable_desc")}</div></div></label>
                                <br>
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomUnwatchedOnly" ${e.currentSettings.randomUnwatchedOnly?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;"><div><div style="font-weight:500;">${e.t("panel_settings_random_button_unwatched")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_random_button_unwatched_desc")}</div></div></label>
                            </div>
                            <div style="font-weight:500; margin-bottom:8px;">${e.t("panel_settings_random_button_types")}</div>
                            <div style="display:flex; gap:16px; padding:12px; background:${n}; border-radius:6px; border-left:3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeMovies" ${e.currentSettings.randomIncludeMovies?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;"><span>${e.t("panel_settings_random_button_movies")}</span></label>
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeShows" ${e.currentSettings.randomIncludeShows?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;"><span>${e.t("panel_settings_random_button_shows")}</span></label>
                            </div>
                            <div style="font-weight:500; margin:16px 0 8px;">${e.t("panel_settings_random_button_source")}</div>
                            <div style="padding:12px; background:${n}; border-radius:6px; border-left:3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomScopeCurrentContainer" ${e.currentSettings.randomScopeCurrentContainer?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;"><div><div style="font-weight:500;">${e.t("panel_settings_random_button_scope_current")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_random_button_scope_current_desc")}</div></div></label>
                                <div style="margin-top:12px;">
                                    <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-bottom:6px;">${e.t("panel_settings_random_button_source_desc")}</div>
                                    <!-- Playlists/collections are appended asynchronously in wireMiscSettingsControls -->
                                    <select id="randomSourceSelect" style="width:100%; background:${f}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;"><option value="">${e.t("panel_settings_random_button_source_library")}</option></select>
                                </div>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="ui">
                        <h3 class="je-pane-title">${e.icon(e.IconName.UI)} ${e.t("panel_settings_ui")}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showWatchProgressToggle" ${e.currentSettings.showWatchProgress?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_ui_watch_progress")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_ui_watch_progress_desc")}</div></div>
                                </label>
                                <div style="display:flex; gap:12px; margin-top:10px;">
                                    <div style="flex:1;">
                                        <select id="watchProgressModeSelect" style="width:100%; background:${f}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                                            <option value="percentage" ${e.currentSettings.watchProgressMode==="percentage"?"selected":""}>Percentage</option>
                                            <option value="time" ${e.currentSettings.watchProgressMode==="time"?"selected":""}>Time Watched</option>
                                            <option value="remaining" ${e.currentSettings.watchProgressMode==="remaining"?"selected":""}>Time Remaining</option>
                                        </select>
                                    </div>
                                    <div style="flex:1;">
                                        <select id="watchProgressTimeFormatSelect" style="width:100%; background:${f}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                                            <option value="hours" ${e.currentSettings.watchProgressTimeFormat==="hours"?"selected":""}>h:m</option>
                                            <option value="full" ${e.currentSettings.watchProgressTimeFormat==="full"?"selected":""}>y:mo:d:h:m</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showFileSizesToggle" ${e.currentSettings.showFileSizes?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_ui_file_sizes")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_ui_file_sizes_desc")}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showAudioLanguagesToggle" ${e.currentSettings.showAudioLanguages?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_ui_audio_languages")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_ui_audio_languages_desc")}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t}; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px;">
                                <div><div style="font-weight:500;">${o(e.t("panel_media_tags_moved"))}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${o(e.t("panel_media_tags_moved_desc"))}</div></div>
                                <button type="button" id="jeOpenMediaTags" data-je-open-pane="media-tags" style="font-family:inherit; font-size:13px; font-weight:600; color:#fff; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.22); border-radius:6px; min-height:36px; padding:0 12px; cursor:pointer;">${o(e.t("common_open"))}</button>
                            </div>
                            <div style="padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="removeContinueWatchingToggle" ${e.currentSettings.removeContinueWatchingEnabled?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("panel_settings_ui_remove_continue_watching")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("panel_settings_ui_remove_continue_watching_desc")}</div></div>
                                </label>
                            </div>
                        </div>
                    </section>
                    
                    ${a.buildMediaTagsHubHtml?a.buildMediaTagsHubHtml(p):""}
                    
                    ${i.peer("hiddenContent")?`<section class="je-pane" data-pane="hidden-content">
                        <h3 class="je-pane-title">${e.icon(e.IconName.EYE)} ${e.t("hidden_content_settings_title")}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 12px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenContentEnabledToggle" ${i.peer("hiddenContent")?.getSettings()?.enabled!==!1?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("hidden_content_toggle_label")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("hidden_content_toggle_desc")}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenShowHideButtons" ${i.peer("hiddenContent")?.getSettings()?.showHideButtons!==!1?"checked":""} style="width:18px; height:18px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${e.t("hidden_content_show_buttons_label")}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${e.t("hidden_content_show_buttons_desc")}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenShowConfirmation" ${i.peer("hiddenContent")?.getSettings()?.showHideConfirmation!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                    <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_confirm_toggle_label")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_confirm_toggle_desc")}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px;">
                                <div style="font-weight:500; font-size:13px; color:rgba(255,255,255,0.7); margin-bottom:8px; padding-left:4px;">${e.t("hidden_content_button_section_title")}</div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonJellyseerr" ${i.peer("hiddenContent")?.getSettings()?.showButtonJellyseerr!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_show_button_jellyseerr")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_show_button_jellyseerr_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonLibrary" ${i.peer("hiddenContent")?.getSettings()?.showButtonLibrary?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_show_button_library")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_show_button_library_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonDetails" ${i.peer("hiddenContent")?.getSettings()?.showButtonDetails!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_show_button_details")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_show_button_details_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonCast" ${i.peer("hiddenContent")?.getSettings()?.showButtonCast?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_show_button_cast")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_show_button_cast_desc")}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div id="hiddenContentSurfaceToggles" style="margin-bottom: 12px;">
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterLibrary" ${i.peer("hiddenContent")?.getSettings()?.filterLibrary!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_library")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_library_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterDiscovery" ${i.peer("hiddenContent")?.getSettings()?.filterDiscovery!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_discovery")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_discovery_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterSearch" ${i.peer("hiddenContent")?.getSettings()?.filterSearch!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_search")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_search_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterCalendar" ${i.peer("hiddenContent")?.getSettings()?.filterCalendar!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_calendar")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_calendar_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterUpcoming" ${i.peer("hiddenContent")?.getSettings()?.filterUpcoming!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_upcoming")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_upcoming_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterRecommendations" ${i.peer("hiddenContent")?.getSettings()?.filterRecommendations!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_recommendations")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_recommendations_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterRequests" ${i.peer("hiddenContent")?.getSettings()?.filterRequests!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_requests")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_requests_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterNextUp" ${i.peer("hiddenContent")?.getSettings()?.filterNextUp!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_nextup")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_nextup_desc")}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterContinueWatching" ${i.peer("hiddenContent")?.getSettings()?.filterContinueWatching!==!1?"checked":""} style="width:16px; height:16px; accent-color:${t}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_filter_continue")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_filter_continue_desc")}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid rgba(255, 180, 50, 0.6);">
                                <div style="font-weight:500; font-size:13px; color:rgba(255, 180, 50, 0.9); margin-bottom:8px; padding-left:4px;">${e.t("hidden_content_experimental_label")}</div>
                                <div style="padding: 12px; background: rgba(255, 180, 50, 0.05); border-radius: 6px; border-left: 3px solid rgba(255, 180, 50, 0.3);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenExperimentalCollections" ${i.peer("hiddenContent")?.getSettings()?.experimentalHideCollections?"checked":""} style="width:16px; height:16px; accent-color:rgba(255, 180, 50, 0.8); cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${e.t("hidden_content_experimental_collections")}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${e.t("hidden_content_experimental_collections_desc")}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div style="padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <button id="manageHiddenContentBtn" style="width: 100%; padding: 12px; background: ${t}; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
                                    ${e.t("hidden_content_manage_button")} (${i.peer("hiddenContent")?.getHiddenCount()||0})
                                </button>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${e.t("hidden_content_manage_desc")}</div>
                            </div>
                        </div>
                    </section>`:""}
                    ${i.peer("spoilerBlur")?.buildSettingsHtml?.(p)||""}
                    <section class="je-pane" data-pane="language">
                        <h3 class="je-pane-title">${e.icon(e.IconName.LANGUAGE)} ${e.t("panel_settings_language")}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px;">
                                <div style="font-weight: 600; margin-bottom: 8px;">${e.t("panel_settings_language_display")}</div>
                                <select id="displayLanguageSelect" style="width: 100%; padding: 12px; background: ${n}; color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; font-size: 14px; cursor: pointer; font-family: inherit;">
                                    <option value="" style="background: rgba(30,30,30,1); color: #fff;">Auto</option>
                                    <!-- Languages will be populated dynamically -->
                                </select>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${e.t("panel_settings_language_display_desc")}</div>
                            </div>
                            <div style="padding: 12px; background: ${n}; border-radius: 6px; border-left: 3px solid ${t};">
                                <button id="clearTranslationCacheButton" style="width: 100%; padding: 12px; background: ${t}; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
                                    ${e.t("panel_settings_language_clear_cache")}
                                </button>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${e.t("panel_settings_language_clear_cache_desc")}</div>
                            </div>
                        </div>
                    </section>
                    <section class="je-pane" data-pane="about">
                        <h3 class="je-pane-title">${e.icon(e.IconName.QUESTION)} ${o(g("panel_about_title","About"))}</h3>
                        <div style="padding: 4px 0 16px 0; display: flex; flex-direction: column; gap: 14px;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="font-size: 28px; line-height: 1;">${e.icon(e.IconName.JELLYFISH)}</div>
                                <div>
                                    <div style="font-weight: 700; font-size: 16px;">Jellyfin Enhanced</div>
                                    <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${o(e.t("panel_version",{version:String(e.pluginVersion)}))}</div>
                                </div>
                            </div>
                            <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                                <button id="releaseNotesBtn" style="font-family:inherit; background:${T}; color:${Y}; border:${K}; padding:8px 14px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; gap:6px;" onmouseover="this.style.background='${l}'" onmouseout="this.style.background='${T}'">${e.t("panel_footer_release_notes")}</button>
                                <a href="https://github.com/${c}/" target="_blank" style="color:${l}; text-decoration:none; display:flex; align-items:center; gap:6px; font-size:13px; padding:8px 12px; border-radius:8px; background:${P}; transition:background 0.2s;" onmouseover="this.style.background='rgba(102, 179, 255, 0.2)'" onmouseout="this.style.background='${P}'"><svg height="13" viewBox="0 0 24 24" width="13" fill="currentColor"><path d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.193 10.193 0 0 1 2.75-.371c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z"></path></svg> ${e.t("panel_footer_contribute")}</a>
                            </div>
                            ${z?`<img src="${o(z)}" class="footer-logo" alt="Theme Logo" style="height: 40px; align-self: flex-start;">`:""}
                        </div>
                    </section>
                </div>
                </div>
            </div>
            <div class="panel-footer" style="padding: 10px 20px; border-top: 1px solid rgba(255,255,255,0.1); background: ${u}; display: flex; justify-content: center; align-items: center;">
                <div class="close-helptext" style="font-size:12px; color:rgba(255,255,255,0.5);">${e.t("panel_footer_close")}</div>
            </div>
            ${a.buildPanelResizeHandlesHtml?a.buildPanelResizeHandlesHtml():""}
        `}}Z(_());})();
})();

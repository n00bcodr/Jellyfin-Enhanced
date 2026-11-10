import { catchupHost } from './host';
import catchupCss from './catchup.css';
/**
 * @file Catch Up styles. Everything sits under .je-catchup or the .je-catchup-modal overlay, so
 * nothing leaks into Jellyfin or other plugins. Flat surfaces, the theme accent and Jellyfin's
 * Material icons, like the Activity and Hidden Content pages.
 */
(function () {
  'use strict';
  const { ctx: context } = catchupHost();
  if (!context) return;
  const ctx = context, JE = ctx.core;


  if (!JE?.pluginConfig?.CatchUpEnabled) return;
  const internal = ctx.own.catchUp;
  if(!internal)return;

  const CSS = catchupCss;

  /** Publishes the theme colors from the themer as CSS variables. */
  function injectStyles() {
    let t: {primaryAccent?: string; panelBg?: string; secondaryBg?: string} = {};
    try { t = JE?.themer?.getThemeVariables?.() || {}; } catch (_) { /* fall back to CSS defaults */ }
    const root = document.documentElement.style;
    [['accent', t.primaryAccent], ['panel', t.panelBg], ['secondary', t.secondaryBg]]
      .forEach(([k, v]) => { if (v && !/gradient/i.test(v)) root.setProperty(`--je-catchup-${k}`, v); });
    if (document.getElementById('je-catchup-styles')) return;
    const style = document.createElement('style');
    style.id = 'je-catchup-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  internal.injectStyles = injectStyles;
})();

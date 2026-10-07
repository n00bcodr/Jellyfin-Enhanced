/**
 * @file Catch Up styles. Everything sits under .je-catchup or the .je-catchup-modal overlay, so
 * nothing leaks into Jellyfin or other plugins. Flat surfaces, the theme accent and Jellyfin's
 * Material icons, like the Activity and Hidden Content pages.
 */
(function () {
  'use strict';

  const JE = window.JellyfinEnhanced;
  if (!JE?.pluginConfig?.CatchUpEnabled) return;
  const internal = JE.internals.catchUp;

  const CSS = `
.je-catchup { --sw-accent:var(--je-catchup-accent,#00a4dc); --sw-text:#fff; --sw-panel-bg:linear-gradient(var(--je-catchup-panel,#202020),var(--je-catchup-panel,#202020)) #181818;
  --sw-surface:var(--je-catchup-secondary,rgba(255,255,255,0.05)); --sw-surface-hover:color-mix(in srgb,var(--sw-text) 10%,transparent);
  --sw-line:color-mix(in srgb,var(--sw-text) 12%,transparent); --sw-muted:color-mix(in srgb,var(--sw-text) 60%,transparent);
  --sw-green:#4caf50; --sw-red:#e5484d; --sw-amber:#f2b01e; --sw-blue:var(--sw-accent);
  display:flex; align-items:flex-start; gap:24px; width:100%; box-sizing:border-box; padding:20px 3vw 32px; color:var(--sw-text); }
.je-catchup *, .je-catchup-modal * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
.je-catchup button { font-family:inherit; }
.je-catchup .material-icons, .je-catchup-modal .material-icons { font-size:22px; line-height:1; }

.je-catchup-main { flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; }
.je-catchup-head { width:100%; max-width:520px; display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:14px; }
.je-catchup-title { font-size:24px; font-weight:700; color:var(--sw-text); }
.je-catchup-headbtns { display:flex; gap:8px; align-items:center; }
.je-catchup-btn { display:inline-flex; align-items:center; gap:6px; background:var(--sw-surface); border:1px solid var(--sw-line); color:inherit;
  border-radius:6px; padding:6px 12px; font-size:14px; cursor:pointer; }
.je-catchup-btn:hover { background:var(--sw-surface-hover); }
.je-catchup-btn.on { border-color:var(--sw-accent); color:var(--sw-accent); }
.je-catchup-btn .material-icons { font-size:18px; }

.je-catchup-tabs { display:flex; gap:4px; margin-bottom:14px; }
.je-catchup-tabs button { background:none; border:0; border-bottom:2px solid transparent; color:var(--sw-muted); font-size:15px; padding:6px 16px; cursor:pointer; }
.je-catchup-tabs button:hover { color:var(--sw-text); }
.je-catchup-tabs button.on { color:var(--sw-text); border-bottom-color:var(--sw-accent); font-weight:600; }

.je-catchup-stage { position:relative; width:100%; max-width:420px; height:calc(100dvh - 22rem); min-height:380px; }
.je-catchup-card { position:absolute; top:50%; left:50%; translate:-50% -50%; width:min(100%, calc((100dvh - 22rem - 100px) / 1.5)); max-height:100%; border-radius:8px; overflow:hidden;
  background:var(--sw-panel-bg); border:1px solid var(--sw-line); box-shadow:0 6px 20px rgba(0,0,0,0.45);
  touch-action:none; user-select:none; will-change:transform; display:flex; flex-direction:column; }
.je-catchup-card.leaving { pointer-events:none; }
.je-catchup-card.back { transform:scale(.95) translateY(10px); opacity:.6; pointer-events:none; }
.je-catchup-card img { flex:none; aspect-ratio:2/3; width:100%; object-fit:cover; pointer-events:none; background:#101010; }
.je-catchup-meta { padding:10px 14px 12px; flex:none; overflow:hidden; border-top:1px solid var(--sw-line); }
.je-catchup-meta h2 { margin:0 0 2px; font-size:17px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.je-catchup-meta p { margin:0; opacity:.75; font-size:13px; }
.je-catchup-meta .ov { margin-top:6px; font-size:13px; opacity:.6; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }

.je-catchup-stamp { position:absolute; top:24px; padding:4px 12px; border:3px solid; border-radius:6px; font-weight:800; font-size:22px; letter-spacing:1px;
  white-space:nowrap; opacity:0; pointer-events:none; background:rgba(0,0,0,0.5); }
.je-catchup-stamp.r { left:16px; color:var(--sw-green); transform:rotate(-12deg); }
.je-catchup-stamp.l { right:16px; color:var(--sw-red); transform:rotate(12deg); }
.je-catchup-stamp.u { left:50%; color:var(--sw-amber); transform:translateX(-50%); }
.je-catchup-stamp.d { left:50%; color:var(--sw-blue); transform:translateX(-50%); }

.je-catchup-buttons { display:flex; gap:14px; padding:14px 0 8px; }
.je-catchup-buttons button { width:48px; height:48px; border-radius:50%; border:1px solid var(--sw-line); background:var(--sw-surface); color:inherit; padding:0; cursor:pointer;
  display:flex; align-items:center; justify-content:center; transition:background .15s, transform .1s; }
.je-catchup-buttons button:hover { background:var(--sw-surface-hover); }
.je-catchup-buttons button:active { transform:scale(.92); }
.je-catchup-buttons .z { color:var(--sw-muted); } .je-catchup-buttons .l { color:var(--sw-red); } .je-catchup-buttons .u { color:var(--sw-amber); }
.je-catchup-buttons .d { color:var(--sw-blue); } .je-catchup-buttons .r { color:var(--sw-green); }
.je-catchup-hint { font-size:12px; opacity:.55; text-align:center; }
.je-catchup-empty { position:absolute; inset:0; display:none; align-items:center; justify-content:center; text-align:center; opacity:.7; padding:30px; }

/* season picker dialog */
.je-catchup-modal { position:fixed; inset:0; z-index:10000; display:none; align-items:center; justify-content:center; padding:20px; color:var(--sw-text); background:rgba(0,0,0,0.6); }
.je-catchup-modal .box { max-width:440px; width:100%; border-radius:8px; padding:22px; background:var(--sw-panel-bg); border:1px solid var(--sw-line); box-shadow:0 12px 40px rgba(0,0,0,0.6); }
.je-catchup-modal h3 { margin:0 0 8px; font-size:20px; }
.je-catchup-modal p { margin:0 0 12px; opacity:.8; }
.je-catchup-modal ul { list-style:none; padding:0; margin:0 0 14px; display:grid; gap:8px; }
.je-catchup-modal li { display:grid; grid-template-columns:96px 1fr; gap:10px; align-items:baseline; }
.je-catchup-modal .primary { width:100%; padding:11px; border:0; border-radius:6px; color:#fff; font-size:15px; font-weight:600; cursor:pointer; margin-bottom:8px; background:var(--je-catchup-accent, #00a4dc); }
.je-catchup-modal .primary:disabled { opacity:.4; cursor:default; }
.je-catchup-modal .ghost { width:100%; padding:10px; border-radius:6px; border:1px solid var(--sw-line); background:none; color:var(--sw-muted); cursor:pointer; }
.je-catchup-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(56px,1fr)); gap:8px; margin-bottom:12px; }
.je-catchup-grid button { padding:10px 6px; border-radius:6px; border:1px solid var(--sw-line); background:var(--sw-surface); color:inherit; font-size:14px; cursor:pointer; }
.je-catchup-grid button { display:flex; flex-direction:column; align-items:center; gap:2px; }
.je-catchup-grid button small { font-size:10px; opacity:.65; font-weight:400; }
.je-catchup-grid button.done { border-color:var(--sw-green); }
.je-catchup-grid button.on { background:var(--je-catchup-accent, #00a4dc); border-color:transparent; color:#fff; font-weight:700; }

/* admin activity panel: a side column on wide screens, a dialog otherwise */
.je-catchup-activity { display:none; }
.je-catchup-activity.open { display:flex; position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.6); padding:12px; align-items:center; justify-content:center; }
.je-catchup-activity .panel { width:100%; max-width:860px; max-height:100%; display:flex; flex-direction:column; border-radius:8px; overflow:hidden; background:var(--sw-panel-bg); border:1px solid var(--sw-line); }
@media (min-width:1100px) {
  .je-catchup.docked .je-catchup-activity.open { position:sticky; top:20px; inset:auto; z-index:1; width:400px; flex:none; padding:0; background:none; display:flex; align-items:stretch; max-height:calc(100dvh - 8rem); }
  .je-catchup.docked .je-catchup-activity .panel { max-width:none; background:var(--sw-surface); }
  .je-catchup.docked .arow { grid-template-columns:56px 1fr; }
  .je-catchup.docked .arow .u { grid-column:2; } .je-catchup.docked .arow .a { grid-column:1; grid-row:2; } .je-catchup.docked .arow .i { grid-column:2; grid-row:2; }
  .je-catchup.docked .ucards { grid-template-columns:1fr 1fr; }
}
.je-catchup-activity .ahead { display:flex; align-items:center; gap:8px; padding:14px 16px 8px; }
.je-catchup-activity .ahead h3 { margin:0; font-size:20px; font-weight:700; flex:1; }
.je-catchup-activity .atabs { display:flex; gap:4px; padding:0 16px; border-bottom:1px solid var(--sw-line); }
.je-catchup-activity .atabs button { background:none; border:0; border-bottom:2px solid transparent; color:var(--sw-muted); font-size:14px; padding:8px 12px; cursor:pointer; }
.je-catchup-activity .atabs button.on { color:var(--sw-text); border-bottom-color:var(--sw-accent); font-weight:600; }
.je-catchup-activity .afilters { display:flex; flex-wrap:wrap; gap:8px; padding:12px 16px 8px; }
.je-catchup-activity .afilters select, .je-catchup-activity .afilters input { background:var(--sw-surface); border:1px solid var(--sw-line); color:inherit; border-radius:6px; padding:6px 10px; font-size:13px; outline:none; min-width:0; }
.je-catchup-activity .afilters input { flex:1; min-width:120px; } .je-catchup-activity .afilters option { background:#202020; }
.je-catchup-activity .fchips { display:flex; flex-wrap:wrap; gap:6px; width:100%; order:3; }
.je-catchup-activity .chip { border:1px solid var(--sw-line); background:none; color:var(--sw-muted); border-radius:14px; padding:3px 12px; font-size:12.5px; cursor:pointer; }
.je-catchup-activity .chip:hover { background:var(--sw-surface-hover); }
.je-catchup-activity .chip.on { color:var(--sw-text); border-color:var(--sw-muted); background:var(--sw-surface-hover); }
.je-catchup-activity .chip.on[data-a=watched] { border-color:var(--sw-green); color:var(--sw-green); } .je-catchup-activity .chip.on[data-a=dismiss] { border-color:var(--sw-red); color:var(--sw-red); }
.je-catchup-activity .chip.on[data-a=watchlist] { border-color:var(--sw-amber); color:var(--sw-amber); } .je-catchup-activity .chip.on[data-a=open] { border-color:var(--sw-blue); color:var(--sw-blue); }
.je-catchup-activity .abody { flex:1; overflow:auto; padding:0 8px 8px; }
.je-catchup-activity .arow { display:grid; grid-template-columns:78px 70px 92px 1fr; gap:8px; align-items:center; padding:10px 8px; border-bottom:1px solid var(--sw-line); font-size:13px; }
.je-catchup-activity .arow .t { opacity:.6; font-size:12px; }
.je-catchup-activity .arow .u { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.je-catchup-activity .arow .i { min-width:0; } .je-catchup-activity .arow .i a { color:inherit; font-weight:600; text-decoration:none; cursor:pointer; } .je-catchup-activity .arow .i a:hover { text-decoration:underline; }
.je-catchup-activity .arow .i small { display:block; opacity:.6; font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.je-catchup-activity .tag { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11.5px; font-weight:700; border:1px solid currentColor; }
.je-catchup-activity .tag.watched { color:var(--sw-green); } .je-catchup-activity .tag.dismiss { color:var(--sw-red); }
.je-catchup-activity .tag.watchlist { color:var(--sw-amber); } .je-catchup-activity .tag.open { color:var(--sw-blue); }
.je-catchup-activity .tag.fail { text-decoration:line-through; } .je-catchup-activity .tag.undo { color:var(--sw-muted); } .je-catchup-activity .tag.fail { opacity:.7; }
.je-catchup-activity .ucards { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; padding:12px 8px; }
.je-catchup-activity .ucard { border-radius:8px; padding:12px 14px; background:var(--sw-surface); border:1px solid var(--sw-line); }
.je-catchup-activity .ucard b { font-size:15px; } .je-catchup-activity .ucard .stats { display:flex; gap:14px; margin:8px 0 4px; } .je-catchup-activity .ucard .stats div { text-align:center; }
.je-catchup-activity .ucard .stats span { display:block; font-size:20px; font-weight:700; } .je-catchup-activity .ucard .stats small { opacity:.6; font-size:11px; text-transform:lowercase; }
.je-catchup-activity .ucard .ls { opacity:.6; font-size:12px; }
.je-catchup-activity .tops { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px; padding:4px 8px 8px; }
.je-catchup-activity .tops h4 { margin:6px 0 6px; font-size:13px; opacity:.6; font-weight:600; }
.je-catchup-activity .toprow { display:flex; justify-content:space-between; gap:8px; padding:6px 0; font-size:13px; border-bottom:1px solid var(--sw-line); }
.je-catchup-activity .toprow a { color:inherit; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; } .je-catchup-activity .toprow span { opacity:.6; white-space:nowrap; }
.je-catchup-activity .aempty { opacity:.7; text-align:center; padding:28px 16px; font-size:14px; }
@media (max-width:1099px) { .je-catchup { flex-direction:column; align-items:center; } }
@media (max-width:600px) {
  .je-catchup { padding:14px 0 28px; }
  .je-catchup-activity .arow { grid-template-columns:56px 1fr; }
  .je-catchup-activity .arow .u { grid-column:2; } .je-catchup-activity .arow .a { grid-column:1; grid-row:2; } .je-catchup-activity .arow .i { grid-column:2; grid-row:2; }
}`;

  /** Publishes the theme colors from the themer as CSS variables. */
  function injectStyles() {
    let t = {};
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

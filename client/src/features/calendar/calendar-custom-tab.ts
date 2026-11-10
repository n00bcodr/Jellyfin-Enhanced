import { calendarHost } from './host';
import { invalidate, own } from './lifetime';

(function () {
 const {JE, ctx} = calendarHost();
 const config = JE.pluginConfig;
 if (!config?.CalendarPageEnabled || !config.CalendarUseCustomTabs && !config.CalendarUseNativeTab) return;
 const lifecycle = JE.core.lifecycle.register('arr-calendar-custom-owner');
 lifecycle.teardown();
 let disposed = false;
 let lastMountedContainer: HTMLElement | null = null;
 let clicks: ((event: Event) => void) | null = null;
 let watcher: {teardown(): void} | null = null;
 const style = document.createElement('style');
 style.textContent = `.jellyfinenhanced.calendar {padding: 12px 3vw;}
 .backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.calendar) {background: rgba(0,0,0,.7) !important; opacity: 1 !important;}`;
 document.head.appendChild(style);
 let timer: ReturnType<typeof setInterval> | undefined;
 const dispose = () => {
  if (disposed) return;
  disposed = true;
  if (timer !== undefined) clearInterval(timer);
  watcher?.teardown(); style.remove();
  if (clicks) document.removeEventListener('click',clicks);
  if (lastMountedContainer) invalidate(ctx);
  lastMountedContainer = null;
 };
 own(ctx,'custom-tab',dispose);
 lifecycle.track(dispose);
 function isHome() {
  return /^(?:#\/home(?:\.html)?(?:\?.*)?)?$/.test(window.location.hash);
 }
 function reconcile() {
  if (disposed) return;
  const candidates = isHome() ? [...document.querySelectorAll<HTMLElement>('.jellyfinenhanced.calendar')] : [];
  const container = candidates.reverse().find(el => JE.helpers.isActiveTabContainer(el)) ?? null;
  if (!container) {
   if (lastMountedContainer) {
    invalidate(ctx);
    const state = ctx.own.calendarPage?.state;
    if (state) state._customTabContainer = null;
   }
   lastMountedContainer = null;
   return;
  }
  if (container === lastMountedContainer && container.hasChildNodes()) return;
  const page = JE.calendarPage;
  if (!page) return;
  invalidate(ctx);
  container.classList.remove('hide'); container.style.display = '';
  const child = document.createElement('div'); child.id = 'je-calendar-container-tab';
  container.replaceChildren(child);
  lastMountedContainer = container;
  page.renderForCustomTab(child);
  if (!clicks) {clicks = page.handleEventClick; document.addEventListener('click',clicks);}
 }
 // Helpers and native-tabs load later in some supported paths: resolve at readiness time.
 let attempts = 0;
 function ready() {
  if (disposed) return;
  if (!JE.calendarPage || !JE.helpers?.observeTabContainers || config?.CalendarUseNativeTab && !JE.nativeTabs?.register) {
   if (++attempts >= 300) dispose();
   return;
  }
  if (timer !== undefined) clearInterval(timer);
  if (config?.CalendarUseNativeTab) JE.nativeTabs.register('calendar',JE.t('calendar_title') || 'Calendar',panel => {
   if (disposed) return;
   const marker = document.createElement('div'); marker.className = 'jellyfinenhanced calendar'; panel.appendChild(marker);
  },'calendar_month');
  watcher = JE.helpers.observeTabContainers('arr-calendar-custom-tab','.jellyfinenhanced.calendar',reconcile);
  reconcile();
 }
 timer = setInterval(ready,100);
 ready();
})();

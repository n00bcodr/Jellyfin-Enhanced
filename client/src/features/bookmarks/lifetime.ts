import { lease, type BookmarksContext } from './host';
export interface BookmarkLifetime { dispose(): void }
export function createLifetime(ctx: BookmarksContext, name: string) {
 const JE = ctx.core, own = ctx.own;
 own.bookmarkLifetimes ??= {};
 own.bookmarkLifetimes[name]?.dispose();
 const cleanup = new Set<() => void>();
 const dialogs = new Set<() => void>();
 let disposed = false;
 let generation = 0;
 const pending = new Set<() => void>();
 const keep = (value: unknown) => {
  if (typeof value === 'function') cleanup.add(() => value());
  else if (typeof value === 'object' && value !== null && 'unsubscribe' in value && typeof value.unsubscribe === 'function') {
   const unsubscribe = value.unsubscribe.bind(value); cleanup.add(() => unsubscribe());
  }
 };
 const keepTeardown = (value: unknown) => {
  if (typeof value === 'object' && value !== null && 'teardown' in value && typeof value.teardown === 'function') {
   const teardown = value.teardown.bind(value); cleanup.add(() => teardown());
  } else keep(value);
 };
 const listen = (target: EventTarget, event: string, callback: EventListener, capture = false) => {
  target.addEventListener(event, callback, capture);
  cleanup.add(() => target.removeEventListener(event, callback, capture));
 };
 const timeout = (callback: () => void, delay: number) => {
  const current = lease(JE), version = generation;
  const cancel = () => {window.clearTimeout(id); cleanup.delete(cancel); pending.delete(cancel);};
  const id = window.setTimeout(() => {cleanup.delete(cancel); pending.delete(cancel); if (!disposed && generation === version && current()) callback();}, delay);
  cleanup.add(cancel); pending.add(cancel); return id;
 };
 const interval = (callback: () => void, delay: number) => {
  const id = window.setInterval(() => {if (!disposed) callback();}, delay);
  cleanup.add(() => window.clearInterval(id)); return id;
 };
 const modal = (element: HTMLElement) => {
  const previousFocus = document.activeElement;
  element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true'); element.tabIndex = -1;
  const close = () => {
   element.remove(); cleanup.delete(close); dialogs.delete(close);
   document.removeEventListener('viewshow', close);
   if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  cleanup.add(close); dialogs.add(close);
  document.addEventListener('viewshow', close);
  element.addEventListener('keydown', event => {
   if (event.key === 'Escape') {event.preventDefault(); close();}
   if (event.key !== 'Tab') return;
   const controls = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
   const first = controls[0], last = controls[controls.length - 1];
   if (!first || !last) {event.preventDefault(); element.focus(); return;}
   if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {event.preventDefault(); last.focus();}
   else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
  });
  timeout(() => {if (element.isConnected) (element.querySelector<HTMLElement>('input') || element.querySelector<HTMLElement>('button') || element).focus();}, 0);
  return close;
 };
 const cancelPending = () => {
  generation++;
  for (const cancel of pending) cancel();
  for (const close of dialogs) close();
 };
 const dispose = () => {
  if (disposed) return;
  disposed = true;
  cancelPending();
  for (const release of cleanup) release();
  cleanup.clear();
 };
 const result = {dispose, cancelPending, keep: keepTeardown, listen, timeout, interval, modal, current: () => {
  const current = lease(JE), version = generation; return () => !disposed && generation === version && current();
 }};
 own.bookmarkLifetimes[name] = result;
 keep(JE.session?.onUserChange('bookmarks-' + name, () => {
  for (const close of dialogs) close();
  document.querySelectorAll('.je-bm-player-modal-overlay, .je-bm-library-modal-overlay, .je-bookmark-marker').forEach(el => el.remove());
  document.querySelectorAll('.sections.bookmarks').forEach(el => el.replaceChildren());
 }));
 // Only the document's own unload disposes: jellyfin-web dispatches a bubbling legacy `pagehide` on the view it
 // hides (it reaches window with that element as target), and a back/forward-cache hide (persisted) may be shown again.
 listen(window, 'pagehide', event => {if (event.target === window && !(event as PageTransitionEvent).persisted) dispose();});
 return result;
}

import { tagRuntimeHost } from '../../../host';
import { createStatusTagBackdrop } from './painter';
import { tagClass } from './state';

// js/tags/status-tag-backdrop.js (upstream abcaa16d): the status tags' painted backdrop, JE.statusTagBackdrop. Its own
// component group (tag-status-backdrop): statustags.ts asks the loader for it when the first status tag is drawn.
const JE = tagRuntimeHost();
const backdrop = createStatusTagBackdrop(JE);
JE.statusTagBackdrop = backdrop;

// The tags drawn while this file was on its way.
const waiting = new Set<HTMLElement>();
document.querySelectorAll(`.je-tag-host .${tagClass}`).forEach((tag) => {
    const host = tag.closest<HTMLElement>('.je-tag-host');
    if (host) waiting.add(host);
});
waiting.forEach((host) => backdrop.track(host));

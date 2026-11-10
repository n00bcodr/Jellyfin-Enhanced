import type { DefineSections } from '../engine/schema';
import { defineDisplay } from './display';
import { defineElsewhere } from './elsewhere';
import { definePlayback } from './playback';
import { definePages } from './pages';
import { defineExtras } from './extras';
import { defineSeerr } from './seerr';
import { defineArr } from './arr';
import { defineAdmin } from './admin';
import { defineAbout } from './about';

/** Every tab's section definitions, in the order the page lists them. */
export function defineAllSections(define: DefineSections): void {
    defineDisplay(define);
    defineElsewhere(define);
    definePlayback(define);
    definePages(define);
    defineExtras(define);
    defineSeerr(define);
    defineArr(define);
    defineAdmin(define);
    defineAbout(define);
}

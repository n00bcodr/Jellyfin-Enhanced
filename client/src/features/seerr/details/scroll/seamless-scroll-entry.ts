import { bridgeOrNew } from '../../host-details';
import { CONFIG, cardsNeeded, createDeduplicator, createScrollEngine } from './seamless-scroll';

const JE = bridgeOrNew();
const { setupInfiniteScroll, cleanupInfiniteScroll } = createScrollEngine(JE);
JE.seamlessScroll = { createDeduplicator, cardsNeeded, setupInfiniteScroll, cleanupInfiniteScroll, CONFIG };

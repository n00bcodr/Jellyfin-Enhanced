import { parseBootstrap, parseSettingsDocument, parseBookmarkDocument } from './bootstrap';

// Narrow bridge for the transitional plugin.js loader. The feature owns this one global.
Object.defineProperty(window, '__JE_BOOTSTRAP_CONTRACT__', {
  value: Object.freeze({ parseBootstrap, parseSettingsDocument, parseBookmarkDocument }), configurable: true
});

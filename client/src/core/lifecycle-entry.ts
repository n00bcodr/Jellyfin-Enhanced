import { createLifecycle } from './lifecycle';
import { coreHost } from '../host/core-host';

const je = coreHost().JellyfinEnhanced;
const core = je.core ?? (je.core = {});
core.lifecycle ??= createLifecycle({
    clearInterval: id => window.clearInterval(id),
    clearTimeout: id => window.clearTimeout(id),
    onNavigate: callback => core.navigation?.onNavigate(callback) ?? (() => {}),
    report: (context, error) => {
        const log = context.startsWith('Error in teardown hook') ? console.error : console.warn;
        log(`🪼 Jellyfin Enhanced: Lifecycle: ${context}:`, error);
    }
});

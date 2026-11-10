import type { ActionContext, ModalScope, MoreInfoModalElement, MoreInfoState } from '../../host-details';

/** What a modal owns: cancellation for its requests, and teardown for what it put outside itself. */
export function createModalScope(): ModalScope {
    const controller = new AbortController();
    const disposers = new Set<() => void>();
    return {
        signal: controller.signal,
        requests: 0,
        onDispose(callback) {
            if (controller.signal.aborted) callback();
            else disposers.add(callback);
        },
        dispose() {
            controller.abort();
            for (const dispose of [...disposers]) dispose();
            disposers.clear();
        },
    };
}

/** Whether a modal is the current one and not already leaving. */
export function isLive(state: MoreInfoState, modal: MoreInfoModalElement | null): boolean {
    return modal !== null && state.currentModal === modal && modal._isClosing !== true;
}

/** For builders called outside a modal: nothing to stale, nothing to tear down. */
export function detachedContext(): ActionContext {
    return { live: () => true, current: () => true, signal: new AbortController().signal, onDispose() {}, scope: null, modal: null };
}

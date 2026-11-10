import type { PageModules } from './modules';
import { formControls, isCheckable } from './dom';
import { asHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type DirtyDeps = Pick<PageModules, 'context' | 'shortcuts'>;

export function createDirty(m: DirtyDeps) {
    const { form, lifecycle } = m.context;

            // Unsaved-changes indicator: diffs a snapshot of every form control against the last saved snapshot.
            const saveDock = asHtml(document.querySelector('.je-save-dock'));

            let _jeSavedSnapshot: string | null = null;

            function jeSnapshotFormState() : string {
                const parts = [];
                formControls(form).forEach((el, i) => {
                    if (el.type === 'file') return; // can't be read back, and not part of the saved config shape
                    if (el.closest('.je-arr-seerr-import-picker')) return; // transient browsing state, not a form change until actually imported
                    if (el.closest('.je-spoiler-apply-existing')) return; // per-run option of an action, not a saved setting
                    const key = el.id || el.name || ('#' + i);
                    parts.push(key + '=' + (isCheckable(el) ? el.checked : el.value));
                });
                // shortcutOverrides is JS state, not bound to persistent <input> elements.
                parts.push('shortcuts=' + JSON.stringify(m.shortcuts.shortcutOverrides));
                return parts.join('');
            }

            /** Call once the form reflects a known-saved state. */
            function jeMarkSaved() : void {
                _jeSavedSnapshot = jeSnapshotFormState();
                jeUpdateDirtyIndicator();
            }

            function jeUpdateDirtyIndicator() : void {
                const dirty = _jeSavedSnapshot !== null && jeSnapshotFormState() !== _jeSavedSnapshot;
                if (saveDock) saveDock.classList.toggle('je-dirty', dirty);
            }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
            form.addEventListener('input', jeUpdateDirtyIndicator);

            form.addEventListener('change', jeUpdateDirtyIndicator);

            // Fallback poll for structural changes that don't fire input/change (adding/removing a row).
            lifecycle.interval(jeUpdateDirtyIndicator, 1000);

            window.addEventListener('beforeunload', (e) => {
                if (!saveDock || !saveDock.classList.contains('je-dirty')) return;
                e.preventDefault();
                e.returnValue = '';
            }, { signal: lifecycle.signal });
    }

    return {
        wire,
        jeMarkSaved,
    };
}

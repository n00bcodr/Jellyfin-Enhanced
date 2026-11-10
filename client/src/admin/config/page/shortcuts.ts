import type { PageModules } from './modules';
import { DEFAULT_SHORTCUTS, shortcutClash, shortcutCombo } from '../domain/shortcuts';
import { needHtml } from './dom';
import type { ShortcutEntry } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type ShortcutsDeps = Pick<PageModules, 'context'>;

export function createShortcuts(m: ShortcutsDeps) {
            const shortcutGrid = needHtml(document.getElementById('shortcut-grid'));

            const shortcutErrorComment = needHtml(document.getElementById('shortcut-error-comment'));

            let shortcutOverrides: ShortcutEntry[] = [];

        const defaultShortcuts = DEFAULT_SHORTCUTS;

        function effectiveShortcutKey(def: ShortcutEntry) : string {
            const o = shortcutOverrides.find(x => x.Name === def.Name);
            return o ? o.Key : def.Key;
        }

        function setShortcutOverride(def: ShortcutEntry, key: string) : void {
            shortcutOverrides = shortcutOverrides.filter(x => x.Name !== def.Name);
            if (key !== def.Key) shortcutOverrides.push({ ...def, Key: key });
            renderOverrides();
        }

        function showValidationError(chip: HTMLElement, message: string) : void {
            shortcutErrorComment.textContent = message;
            shortcutErrorComment.style.display = 'block';
            chip.classList.add('je-sc-error');
            setTimeout(() => {
                chip.classList.remove('je-sc-error');
                shortcutErrorComment.style.display = 'none';
            }, 4000);
        }

        function renderOverrides() : void {
            shortcutGrid.innerHTML = '';
            ['Global', 'Player'].forEach(category => {
                const col = document.createElement('div');
                const title = document.createElement('h4');
                title.textContent = category;
                col.appendChild(title);

                defaultShortcuts.filter(d => d.Category === category && d.Name !== 'JumpToPercentage').forEach(def => {
                    const key = effectiveShortcutKey(def);
                    const isDisabled = key === '';
                    const isModified = shortcutOverrides.some(x => x.Name === def.Name);

                    const row = document.createElement('div');
                    row.className = 'je-sc-row' + (isDisabled ? ' je-sc-disabled' : '');

                    const left = document.createElement('div');
                    left.className = 'je-sc-left';
                    const chip = document.createElement('span');
                    chip.className = 'je-sc-key';
                    chip.textContent = isDisabled ? 'Disabled' : key;
                    {
                        chip.tabIndex = 0;
                        chip.setAttribute('data-je-key-recorder', '1');
                        chip.addEventListener('click', () => chip.focus());
                        chip.addEventListener('focus', () => { chip.textContent = 'Press a key...'; });
                        chip.addEventListener('blur', () => { chip.textContent = isDisabled ? 'Disabled' : key; });
                        chip.addEventListener('keydown', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.key === 'Backspace') { setShortcutOverride(def, def.Key); return; }
                            if (e.key === 'Delete') { setShortcutOverride(def, ''); return; }
                            if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
                            if (e.key === 'Tab') { chip.blur(); return; }

                            const combo = shortcutCombo(e);
                            const clash = shortcutClash(def, combo, defaultShortcuts, effectiveShortcutKey);
                            if (clash) {
                                showValidationError(chip, clash);
                                return;
                            }
                            setShortcutOverride(def, combo);
                        });
                    }
                    left.appendChild(chip);

                    {
                        const toggle = document.createElement('button');
                        toggle.type = 'button';
                        toggle.className = 'je-sc-btn';
                        toggle.title = isDisabled ? 'Enable (restore default key)' : 'Disable for every user';
                        toggle.innerHTML = '<span class="material-icons"' + (isDisabled ? ' style="color: #ff6b6b;"' : '') + '>block</span>';
                        toggle.addEventListener('click', () => setShortcutOverride(def, isDisabled ? def.Key : ''));
                        left.appendChild(toggle);
                    }

                    const right = document.createElement('div');
                    if (isModified) {
                        const dot = document.createElement('span');
                        dot.className = 'je-sc-mod';
                        dot.title = 'Changed from default (' + def.Key + ')';
                        dot.textContent = '\u2022';
                        right.appendChild(dot);
                    }
                    right.appendChild(document.createTextNode(def.Label ?? ''));

                    row.appendChild(left);
                    row.appendChild(right);
                    col.appendChild(row);
                });
                shortcutGrid.appendChild(col);
            });
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        defaultShortcuts,
        renderOverrides,
        get shortcutOverrides() { return shortcutOverrides; },
        set shortcutOverrides(value) { shortcutOverrides = value; },
    };
}

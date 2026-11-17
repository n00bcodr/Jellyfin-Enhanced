/** The Elsewhere settings form's pickers: type to filter, arrow keys and Enter to pick, each pick a removable tag. */
import type { DebounceHelper } from './host';

export function createAutocompleteInput(helpers: Partial<DebounceHelper>, placeholder: string, options: readonly string[], selectedValues: string[]): HTMLDivElement {
    const container = document.createElement('div');
    container.style.cssText = 'position: relative; margin-bottom: 6px;';

    let debounceTimer: number | undefined;
    const filterOptions = (filterText: string) => {
        const value = filterText.toLowerCase();
        if (value.length === 0) {
            dropdown.style.display = 'none';
            return;
        }
        showDropdown(options.filter(option => option.toLowerCase().includes(value) && !selectedValues.includes(option)));
    };
    // helpers.debounce when available, for consistent behavior
    const debounce = helpers.debounce;
    let pendingText = '';
    const debouncedFilter = debounce ? debounce.call(helpers, () => filterOptions(pendingText), 300) : null;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.style.cssText = `
            width: 100%;
            padding: 10px;
            border: 1px solid #444;
            border-radius: 6px;
            box-sizing: border-box;
            background: #2a2a2a;
            color: #fff;
            font-size: 14px;
        `;

    const dropdown = document.createElement('div');
    dropdown.style.cssText = `
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: #1a1a1a;
            border: 1px solid #444;
            border-top: none;
            border-radius: 6px;
            max-height: 200px;
            overflow-y: auto;
            display: none;
            z-index: 1000;
        `;

    const selectedContainer = document.createElement('div');
    selectedContainer.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 6px;
        `;

    let selectedIndex = -1;
    let filteredOptions: string[] = [];

    function updateSelected(): void {
        selectedContainer.replaceChildren();
        for (const value of selectedValues) {
            const tag = document.createElement('span');
            tag.className = 'selected-tag';
            tag.style.cssText = `
                    background: #0078d4;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 16px;
                    font-size: 12px;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                `;
            tag.textContent = value;
            tag.dataset.value = value;
            const remove = document.createElement('span');
            remove.textContent = '×';
            remove.style.cssText = 'cursor: pointer; font-weight: bold; font-size: 14px;';
            remove.onclick = () => {
                const index = selectedValues.indexOf(value);
                if (index > -1) {
                    selectedValues.splice(index, 1);
                    updateSelected();
                }
            };
            tag.appendChild(remove);
            selectedContainer.appendChild(tag);
        }
    }

    function showDropdown(matches: string[]): void {
        dropdown.replaceChildren();
        dropdown.style.display = 'block';
        filteredOptions = matches;
        selectedIndex = -1;
        matches.forEach((option, index) => {
            const item = document.createElement('div');
            item.textContent = option;
            item.style.cssText = `
                    padding: 10px;
                    cursor: pointer;
                    border-bottom: 1px solid #333;
                    color: #fff;
                    font-size: 14px;
                `;
            item.dataset.index = String(index);
            item.onmouseenter = () => {
                clearSelection();
                item.style.background = '#333';
                selectedIndex = index;
            };
            item.onmouseleave = () => { item.style.background = '#1a1a1a'; };
            item.onclick = () => selectOption(option);
            dropdown.appendChild(item);
        });
    }
    function clearSelection(): void {
        dropdown.querySelectorAll<HTMLElement>('div').forEach(item => { item.style.background = '#1a1a1a'; });
    }
    function updateSelection(): void {
        clearSelection();
        if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
            const item = dropdown.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
            if (item) {
                item.style.background = '#333';
                item.scrollIntoView({ block: 'nearest' });
            }
        }
    }
    function selectOption(option: string): void {
        if (!selectedValues.includes(option)) {
            selectedValues.push(option);
            updateSelected();
        }
        input.value = '';
        dropdown.style.display = 'none';
        selectedIndex = -1;
    }

    input.oninput = () => {
        if (debouncedFilter) {
            pendingText = input.value;
            debouncedFilter();
        } else {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => filterOptions(input.value), 300);
        }
    };
    input.onkeydown = event => {
        if (dropdown.style.display === 'none') return;
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, filteredOptions.length - 1);
                updateSelection();
                break;
            case 'ArrowUp':
                event.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, -1);
                updateSelection();
                break;
            case 'Enter': {
                event.preventDefault();
                const option = filteredOptions[selectedIndex];
                if (selectedIndex >= 0 && option !== undefined) selectOption(option);
                break;
            }
            case 'Escape':
                dropdown.style.display = 'none';
                selectedIndex = -1;
                break;
        }
    };
    input.onblur = () => {
        // Delay hiding to allow clicks on dropdown items
        setTimeout(() => {
            if (!dropdown.contains(document.activeElement)) dropdown.style.display = 'none';
        }, 200);
    };

    container.append(input, dropdown, selectedContainer);
    updateSelected();
    return container;
}

(function(JE) {
    'use strict';
    const A = JE.adminTags;
    if (!A) return;
    A.registerSection({
        id: 'group-custom',
        tab: 'groups',
        order: 80,
        title: 'admin_tags_custom_title', hint: 'admin_tags_custom_desc',
        group: {
            id: 'custom', summary: () => JE.t('admin_tags_custom_desc'), sample: () => [['status', 'Custom']] },
        fields: [
            { id: 'customTagsEnabled', key: 'CustomTagsEnabled', type: 'enable', label: 'admin_tags_customTagsEnabled' },
            { id: 'customTagRules', key: 'CustomTagRules', type: 'custom', label: 'admin_tags_customTagRules' },
        ],
        render(ctx, body) {
            body.innerHTML = `<p class="je-ta-hint" id="customTagRulesHelp">${ctx.tx('admin_tags_custom_desc')}</p>` + A.CUSTOM_HTML;
            const editor = A.createCustomTagRules(body, (rules) => {
                ctx.set('CustomTagRules', rules);
                ctx.root.dispatchEvent(new CustomEvent('je-custom-labels'));
            }, () => ctx.isCurrent());
            let last = '';
            this.loadEditor = () => {
                const next = JSON.stringify(ctx.config.CustomTagRules || []);
                if (next === last) return;
                last = next;
                editor.load(ctx.config);
            };
            // Keep incomplete local rows while their complete siblings auto-save.
            body.addEventListener('input', () => { last = JSON.stringify(ctx.config.CustomTagRules || []); });
            body.addEventListener('change', () => { last = JSON.stringify(ctx.config.CustomTagRules || []); });
            this.loadEditor();
        },
        load() { this.loadEditor?.(); },
    });
})(window.JellyfinEnhanced);

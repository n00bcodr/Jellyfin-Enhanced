(function(JE) {
    'use strict';
    const A = JE.adminTags;
    if (!A) return;
    A.registerSection({
        id: 'group-custom',
        tab: 'groups',
        order: 80,
        title: 'Custom', hint: 'Match existing tags or collections to labels and icons. Up to 20 rules; labels up to 24 characters. Collections require the server cache.',
        group: {
            id: 'custom',
            summary: (ctx) => A.fmt('{n} of {max} rules', { n: Array.isArray(ctx.config.CustomTagRules) ? ctx.config.CustomTagRules.length : 0, max: 20 }), sample: () => [['status', A.fmt('Custom')]] },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'customTagsEnabled', key: 'CustomTagsEnabled', type: 'enable', label: 'Custom tags for new users' },
            { id: 'customTagRules', key: 'CustomTagRules', type: 'custom', label: 'Custom tag rules' },
        ],
        render(ctx, body) {
            body.innerHTML = `<p class="je-ta-hint" id="customTagRulesHelp">${ctx.tx('Match existing tags or collections to labels and icons. Up to 20 rules; labels up to 24 characters. Collections require the server cache.')}</p>` + A.CUSTOM_HTML;
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

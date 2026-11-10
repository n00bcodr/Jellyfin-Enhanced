/**
 * @file Media Tags admin tab, Groups › Logos: which movie and series logos
 * show, their region and how many, for new users.
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
registerSection({
    tab: 'groups',
    title: 'Logos',
    group: { id: 'logos' },
    writes: ['TagGroupScopes'],
        { id: 'logoTagsEnabled', key: 'LogoTagsEnabled', type: 'enable', label: 'Logos for new users' },
        { id: 'logoTagsMovieMode', key: 'LogoTagsMovieMode', type: 'select', label: 'Movie logos' },
        { id: 'logoTagsSeriesMode', key: 'LogoTagsSeriesMode', type: 'select', label: 'Series logos' },
        { id: 'logoTagsRegion', key: 'LogoTagsRegion', type: 'text', label: 'Logo region (two letters; blank follows the server)' },
        { id: 'logoTagsMaxLogos', key: 'LogoTagsMaxLogos', type: 'number', label: 'Maximum logos' },
*/
import { own } from '../values';
import { installSection } from './install';

installSection((A) => {
    A.registerSection({
        id: 'group-logos',
        tab: 'groups',
        order: 70,
        title: 'Logos', hint: 'Choose movie and series logos, their region and maximum count. Images share a fixed 64 MiB cache budget.',
        group: {
            id: 'logos',
            // The current choice, short (the description stays inside the group).
            summary: (ctx) => A.fmt('Movies: {movies} · Series: {series} · up to {n}', {
                movies: own({ provider: 'Provider', studio: 'Studio', off: A.fmt('Off') }, String(ctx.config.LogoTagsMovieMode)) || 'Provider',
                series: own({ network: 'Network', provider: 'Provider', off: A.fmt('Off') }, String(ctx.config.LogoTagsSeriesMode)) || 'Network',
                n: Number(ctx.config.LogoTagsMaxLogos) || 1,
            }),
            sample: () => [['status', A.fmt('Logos')]],
        },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'logoTagsEnabled', key: 'LogoTagsEnabled', type: 'enable', label: 'Logos for new users' },
            { id: 'logoTagsMovieMode', key: 'LogoTagsMovieMode', type: 'select', label: 'Movie logos', options: [['provider', '=Provider'], ['studio', '=Studio'], ['off', 'Off']] },
            { id: 'logoTagsSeriesMode', key: 'LogoTagsSeriesMode', type: 'select', label: 'Series logos', options: [['network', '=Network'], ['provider', '=Provider'], ['off', 'Off']] },
            { id: 'logoTagsRegion', key: 'LogoTagsRegion', type: 'text', label: 'Logo region (two letters; blank follows the server)' },
            { id: 'logoTagsMaxLogos', key: 'LogoTagsMaxLogos', type: 'number', label: 'Maximum logos', min: 1, max: 2, fallback: 1 },
        ],
    });
});

import type { PageContext } from './context';
import type { PageModules } from './modules';
import { createTheme } from './theme';
import { createTabs } from './tabs';
import { createMediaTagsTab } from './media-tags-tab';
import { createLinks } from './links';
import { createDescriptions } from './descriptions';
import { createSearch } from './search';
import { createDirty } from './dirty';
import { createShortcuts } from './shortcuts';
import { createProbes } from './probes';
import { createPlugins } from './plugins';
import { createCustomTabs } from './custom-tabs';
import { createAutoMovie } from './auto-movie';
import { createArr } from './arr';
import { createDisplayCards } from './display-cards';
import { createRegions } from './regions';
import { createSpoiler } from './spoiler';
import { createLoad } from './load';
import { createSave } from './save';
import { createMaintenance } from './maintenance';
import { createBranding } from './branding';
import { createLocales } from './locales';
import { createBindings } from './bindings';
import { createDependencies } from './dependencies';
import { createConnections } from './connections';
import { createWhatsNew } from './whats-new';
import { createOverviewCards } from './overview-cards';
import { createGatedHelp } from './gated-help';
import { createServiceStatus } from './service-status';
import { createDepWiring } from './dep-wiring';
import { createArrTests } from './arr-tests';
import { createMappings } from './mappings';
import { createActions } from './actions';
import { createBlockedUsers } from './blocked-users';
import { createAudit } from './audit';
import { createTiming } from './timing';
import { createBanners } from './banners';
import { createMisc } from './misc';

/** Build every feature module, then run their start-up work in the page's original order. */
export function startPage(context: PageContext): void {
    let theme: PageModules['theme'];
    let tabs: PageModules['tabs'];
    let mediaTagsTab: PageModules['mediaTagsTab'];
    let links: PageModules['links'];
    let descriptions: PageModules['descriptions'];
    let search: PageModules['search'];
    let dirty: PageModules['dirty'];
    let shortcuts: PageModules['shortcuts'];
    let probes: PageModules['probes'];
    let plugins: PageModules['plugins'];
    let customTabs: PageModules['customTabs'];
    let autoMovie: PageModules['autoMovie'];
    let arr: PageModules['arr'];
    let displayCards: PageModules['displayCards'];
    let regions: PageModules['regions'];
    let spoiler: PageModules['spoiler'];
    let load: PageModules['load'];
    let save: PageModules['save'];
    let maintenance: PageModules['maintenance'];
    let branding: PageModules['branding'];
    let locales: PageModules['locales'];
    let bindings: PageModules['bindings'];
    let dependencies: PageModules['dependencies'];
    let connections: PageModules['connections'];
    let whatsNew: PageModules['whatsNew'];
    let overviewCards: PageModules['overviewCards'];
    let gatedHelp: PageModules['gatedHelp'];
    let serviceStatus: PageModules['serviceStatus'];
    let depWiring: PageModules['depWiring'];
    let arrTests: PageModules['arrTests'];
    let mappings: PageModules['mappings'];
    let actions: PageModules['actions'];
    let blockedUsers: PageModules['blockedUsers'];
    let audit: PageModules['audit'];
    let timing: PageModules['timing'];
    let banners: PageModules['banners'];
    let misc: PageModules['misc'];

    const modules: PageModules = {
        context,
        get theme() { return theme; },
        get tabs() { return tabs; },
        get mediaTagsTab() { return mediaTagsTab; },
        get links() { return links; },
        get descriptions() { return descriptions; },
        get search() { return search; },
        get dirty() { return dirty; },
        get shortcuts() { return shortcuts; },
        get probes() { return probes; },
        get plugins() { return plugins; },
        get customTabs() { return customTabs; },
        get autoMovie() { return autoMovie; },
        get arr() { return arr; },
        get displayCards() { return displayCards; },
        get regions() { return regions; },
        get spoiler() { return spoiler; },
        get load() { return load; },
        get save() { return save; },
        get maintenance() { return maintenance; },
        get branding() { return branding; },
        get locales() { return locales; },
        get bindings() { return bindings; },
        get dependencies() { return dependencies; },
        get connections() { return connections; },
        get whatsNew() { return whatsNew; },
        get overviewCards() { return overviewCards; },
        get gatedHelp() { return gatedHelp; },
        get serviceStatus() { return serviceStatus; },
        get depWiring() { return depWiring; },
        get arrTests() { return arrTests; },
        get mappings() { return mappings; },
        get actions() { return actions; },
        get blockedUsers() { return blockedUsers; },
        get audit() { return audit; },
        get timing() { return timing; },
        get banners() { return banners; },
        get misc() { return misc; },
    };

    theme = createTheme(modules);
    tabs = createTabs(modules);
    mediaTagsTab = createMediaTagsTab(modules);
    links = createLinks(modules);
    descriptions = createDescriptions(modules);
    search = createSearch(modules);
    dirty = createDirty(modules);
    shortcuts = createShortcuts(modules);
    probes = createProbes(modules);
    plugins = createPlugins(modules);
    customTabs = createCustomTabs(modules);
    autoMovie = createAutoMovie(modules);
    arr = createArr(modules);
    displayCards = createDisplayCards(modules);
    regions = createRegions(modules);
    spoiler = createSpoiler(modules);
    load = createLoad(modules);
    save = createSave(modules);
    maintenance = createMaintenance(modules);
    branding = createBranding(modules);
    locales = createLocales(modules);
    bindings = createBindings(modules);
    dependencies = createDependencies(modules);
    connections = createConnections(modules);
    whatsNew = createWhatsNew(modules);
    overviewCards = createOverviewCards(modules);
    gatedHelp = createGatedHelp(modules);
    serviceStatus = createServiceStatus(modules);
    depWiring = createDepWiring(modules);
    arrTests = createArrTests(modules);
    mappings = createMappings(modules);
    actions = createActions(modules);
    blockedUsers = createBlockedUsers(modules);
    audit = createAudit(modules);
    timing = createTiming(modules);
    banners = createBanners(modules);
    misc = createMisc(modules);

    theme.wire();
    tabs.wire();
    mediaTagsTab.wire();
    links.wire();
    descriptions.wire();
    search.wire();
    dirty.wire();
    shortcuts.wire();
    probes.wire();
    plugins.wire();
    customTabs.wire();
    autoMovie.wire();
    arr.wire();
    displayCards.wire();
    regions.wire();
    spoiler.wire();
    load.wire();
    save.wire();
    branding.wire();
    maintenance.wire();
    locales.wire();
    bindings.wire();
    dependencies.wire();
    connections.wire();
    whatsNew.wire();
    overviewCards.wire();
    gatedHelp.wire();
    serviceStatus.wire();
    depWiring.wire();
    arrTests.wire();
    mappings.wire();
    actions.wire();
    blockedUsers.wire();
    audit.wire();
    timing.wire();
    banners.wire();
    misc.wire();
}

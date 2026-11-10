import { chromeContext, optionalBridge } from './host';
import { createPluginIcons, type PluginIconsBridge } from './plugin-icons';

const JE = optionalBridge<PluginIconsBridge>();
if (JE) {
    const icons = createPluginIcons(JE);
    const own = chromeContext(JE, ['initializePluginIcons', 'stopPluginIconsMonitoring', 'customPlugins']).own;
    own.initializePluginIcons = icons.initialize;
    own.stopPluginIconsMonitoring = icons.stopMonitoring;
    // Configuration page "Test Links" forces a reload of the custom links.
    own.customPlugins = { refresh: icons.refresh };
}

import { chromeContext, hostClient, optionalBridge } from './host';
import { createThemeSelector, type ThemeClient, type ThemeSelectorBridge } from './theme-selector';

// Baseline reads JE.cdn at load (it must exist); the facade is only published when JE exists.
const JE = optionalBridge<ThemeSelectorBridge>();
if (JE) chromeContext(JE, ['initializeThemeSelector']).own.initializeThemeSelector = createThemeSelector(JE, () => hostClient<ThemeClient>()).initialize;

import { preLoginChromeContext, ensureBridge, optionalBridge } from './host';
import { createSplashScreen, type SplashBridge } from './splashscreen';

const JE = ensureBridge<SplashBridge>();
const splash = createSplashScreen(() => optionalBridge<SplashBridge>()?.pluginConfig);
// Install preemptive styles immediately, before any competing splash renders.
splash.installPreemptiveStyles();
const own = preLoginChromeContext(JE, ['initializeSplashScreen', 'hideSplashScreen']).own;
own.initializeSplashScreen = splash.initializeSplashScreen;
own.hideSplashScreen = splash.hide;
console.log('🪼 Jellyfin Enhanced: Splash screen module loaded.');

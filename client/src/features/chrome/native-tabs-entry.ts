import { chromeBridge, chromeContext, hostClient } from './host';
import { createNativeTabs, type NativeTabsBridge, type NativeTabsClient } from './native-tabs';

const JE = chromeBridge<NativeTabsBridge>();
const tabs = createNativeTabs(JE, () => hostClient<NativeTabsClient>());
chromeContext(JE, ['nativeTabs']).own.nativeTabs = tabs.facade;
tabs.start();

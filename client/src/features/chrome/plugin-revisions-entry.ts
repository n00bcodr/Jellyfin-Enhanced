import { chromeBridge, chromeContext } from './host';
import { initializePluginRevisions, type PluginRevisionsBridge } from './plugin-revisions';

const JE = chromeBridge<PluginRevisionsBridge>();
chromeContext(JE, ['initializePluginRevisions']).own.initializePluginRevisions = () => initializePluginRevisions(JE);

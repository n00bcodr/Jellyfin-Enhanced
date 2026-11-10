import { createTranslations } from './translations';
import { bridge, client, type TranslationsBridge } from './host';
const JE = bridge<TranslationsBridge>();
if (!JE.loadTranslations) JE.loadTranslations = createTranslations(JE, client);

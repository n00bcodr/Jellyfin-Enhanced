import { tagRulesHost } from '../../rules-host';
import { createRatingSources } from './rating-sources';
const bridge = tagRulesHost();
bridge.ratingSources = createRatingSources({
    document,
    translate: key => bridge.t(key),
    get assetUrl() { return bridge.cdn?.url?.bind(bridge.cdn); },
    settings: () => bridge.currentSettings || {},
    config: () => bridge.pluginConfig || {},
    localNumber: text => bridge.core?.mediaLanguage?.formatNumberText(text) ?? String(text),
});

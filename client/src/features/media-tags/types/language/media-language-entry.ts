import { tagRulesHost, localeCandidates } from '../../rules-host';
import { createMediaLanguage } from './media-language';
const bridge = tagRulesHost();
bridge.core ??= {};
bridge.core.mediaLanguage = createMediaLanguage({
    translate: key => bridge.t(key),
    flagSvg: code => bridge.cdn.flagSvg(code),
    localeCandidates: () => localeCandidates(bridge),
    settings: () => bridge.currentSettings || {},
    config: () => bridge.pluginConfig || {},
});

import { tagRulesHost, posterScope } from '../rules-host';
import { createPosterColours } from './poster-colours';
const bridge = tagRulesHost();
bridge.tagPosterColours = createPosterColours({
    scope: () => posterScope(bridge),
    store: () => bridge.tagCacheStore,
    onUserChange: reset => { bridge.session?.onUserChange?.('tag-poster-colours', reset); },
});

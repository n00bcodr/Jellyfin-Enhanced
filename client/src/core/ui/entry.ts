import { createUi } from './runtime';
import { publishFeatureContext } from '../../host/context';
import { browserUiHost, uiBridge } from '../../host/ui-host';

const bridge = uiBridge();
const core = bridge.core ?? (bridge.core = {});
// First, before anything here can throw: every feature host reads this one copy (host/context.ts featureContext).
publishFeatureContext(core);
const ui = core.ui ?? (core.ui = createUi(browserUiHost(bridge)));
bridge.escapeHtml = ui.escapeHtml;
bridge.toast = ui.toast;

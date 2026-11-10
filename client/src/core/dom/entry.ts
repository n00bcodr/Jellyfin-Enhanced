import { createDom } from './runtime';
import { browserDomHost, domBridge } from '../../host/dom-host';

const bridge = domBridge();
const core = bridge.core ?? (bridge.core = {});
core.dom ??= createDom(browserDomHost());

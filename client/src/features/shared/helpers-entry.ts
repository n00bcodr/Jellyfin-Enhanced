import { createHelpers } from './helpers';
import { bridge, client, type HelpersBridge } from './host';
const JE = bridge<HelpersBridge>();
if (!JE.helpers) JE.helpers = createHelpers(JE, client);

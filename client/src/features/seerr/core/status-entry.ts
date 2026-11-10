import { seerrCoreHost } from '../host-core';
import { firstInstall } from './runtime';
import { createStatusFacade } from './status';

// JE.seerrStatus: the status enums and display decisions shared by every Seerr surface.
const { JE } = seerrCoreHost();
if (firstInstall(JE, 'status')) JE.seerrStatus = createStatusFacade();

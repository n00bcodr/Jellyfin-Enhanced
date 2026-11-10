import { seerrCoreHost } from '../../host-core';
import { firstInstall, groupInternals } from '../runtime';
import { ICONS } from './icon-markup';

// Loads first in the Seerr UI group: creates the shared internals (state and
// icon library) its siblings read.
const { JE } = seerrCoreHost();
const internals = groupInternals(JE);
if (firstInstall(JE, 'ui-icons')) {
    const ui = JE.jellyseerrUI ||= {};
    internals.icons = ICONS;
    ui.icons = ICONS;
}

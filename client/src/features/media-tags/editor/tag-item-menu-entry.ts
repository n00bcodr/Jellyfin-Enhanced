import { tagRuntimeHost } from '../host';
import { createItemMenu } from './tag-item-menu';
import { createMaintainerrMenu } from './maintainerr-item-menu';
import { createLeavingSoonPage } from '../leaving-soon/leaving-soon-page';
import { mountLeavingSoonTab } from '../leaving-soon/leaving-soon-custom-tab';

// Administrators' Maintainerr rows in the same menu (upstream 481a10ee loads them as the next script); the Media Tags
// row's capture listener hands them each press.
const maintainerr = createMaintainerrMenu(tagRuntimeHost());
createItemMenu(tagRuntimeHost(), maintainerr.capture);
// The Leaving soon page and its Home tab or Custom Tabs panel (upstream da0ea773 loads them as two later scripts, after
// the item menu whose actions the page reuses). The bundle's load order is pinned, so they ship in this output.
createLeavingSoonPage(tagRuntimeHost());
mountLeavingSoonTab(tagRuntimeHost());

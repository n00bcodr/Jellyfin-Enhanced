import { tagRuntimeHost } from '../host';
import { createItemMenu } from './tag-item-menu';
import { createMaintainerrMenu } from './maintainerr-item-menu';

// Administrators' Maintainerr rows in the same menu (upstream 481a10ee loads them as the next script); the Media Tags
// row's capture listener hands them each press.
const maintainerr = createMaintainerrMenu(tagRuntimeHost());
createItemMenu(tagRuntimeHost(), maintainerr.capture);

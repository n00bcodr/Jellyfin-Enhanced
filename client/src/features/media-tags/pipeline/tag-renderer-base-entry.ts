import { tagRuntimeHost } from '../host';
import { createTagHidden } from './tag-hidden';
import { createTagRenderer } from './tag-renderer-base';
import { createTagText } from './tag-text';

const JE = tagRuntimeHost();
createTagRenderer(JE);
JE.core.tagHidden = createTagHidden(() => JE.pluginConfig);
JE.core.tagText = createTagText(() => JE.pluginConfig);

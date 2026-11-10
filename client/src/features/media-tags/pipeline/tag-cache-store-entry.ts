import { tagRuntimeHost } from '../host';
import { createTagCacheStore } from './tag-cache-store';

tagRuntimeHost().tagCacheStore = createTagCacheStore();

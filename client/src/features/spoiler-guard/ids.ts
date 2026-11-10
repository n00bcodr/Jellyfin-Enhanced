import { spoilerHost } from './host';
import { normalizeId, pendingKey, kindOf } from './ids-logic';
const { internal } = spoilerHost();
internal.normalizeId = normalizeId;
internal.pendingKey = pendingKey;
internal.kindOf = kindOf;

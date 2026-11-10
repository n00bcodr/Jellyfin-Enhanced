import { chromeBridge, eventsContext } from './host';
import { canonicalCombo, createEvents, type EventsBridge } from './events';

const ctx = eventsContext(chromeBridge<EventsBridge>());
// The shortcut editor's conflict check compares bindings the same way.
// ctx.own.canonicalCombo creates JE.internals on first access (host.ts), as `JE.internals = JE.internals || {}` did here.
ctx.own.canonicalCombo = canonicalCombo;
// And as chrome's facade, which the settings panel's shortcut editor reads through ctx.peer (step C4).
ctx.core.canonicalCombo = canonicalCombo;
const events = createEvents(ctx);
ctx.own.keyListener = events.keyListener;
ctx.own.initializeEnhancedScript = events.initializeEnhancedScript;

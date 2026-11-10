import { chromeBridge, chromeContext } from './host';
import { createHeaderActions, type HeaderActionsBridge } from './header-actions';

const JE = chromeBridge<HeaderActionsBridge>();
const actions = createHeaderActions(JE);
JE.session.onUserChange('header-actions', actions.resetForIdentity);
chromeContext(JE, ['headerActions']).own.headerActions = { getTray: actions.getTray };

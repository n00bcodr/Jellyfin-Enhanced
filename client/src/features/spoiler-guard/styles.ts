import { spoilerHost } from './host';
import spoilerGuardCss from './spoiler-guard.css';
const { JE, internal } = spoilerHost();
    internal.injectStyles = function() {
        JE.core.ui.injectCss('je-spoiler-guard-styles', spoilerGuardCss);
    };

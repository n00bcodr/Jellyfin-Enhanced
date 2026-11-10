import { bridge } from '../../host-details';
import { MORE_INFO_CSS } from './styles-css';

bridge().core?.ui?.injectCss?.('je-more-info-modal-styles', MORE_INFO_CSS);

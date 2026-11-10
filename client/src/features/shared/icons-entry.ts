import { createIcons } from './icons';
import { bridge, type IconsBridge } from './host';
const JE = bridge<IconsBridge>();
if (!JE.icons) Object.assign(JE, createIcons(JE));

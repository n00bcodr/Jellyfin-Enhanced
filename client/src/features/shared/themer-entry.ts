import { createThemer } from './themer';
import { bridge, client, type ThemeBridge } from './host';
const JE = bridge<ThemeBridge>();
if (!JE.themer) JE.themer = createThemer(JE);

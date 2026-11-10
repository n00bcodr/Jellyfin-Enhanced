import { requireEngine } from '../../host/admin-config-host';
import { PER_USER_PROPS } from './per-user-props';

const JEAdmin = requireEngine();
JEAdmin.setPerUser(PER_USER_PROPS);

import { engine, publishEngine } from '../../host/admin-config-host';
import { createEngine } from './engine';

/** The served script: this engine, then every Configuration/admin/*.js file. An engine already running is kept. */
if (!engine()) publishEngine(createEngine());

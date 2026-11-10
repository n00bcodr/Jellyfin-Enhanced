import { chromeBridge, chromeContext, hostClient } from './host';
import { createActiveStreams, type ActiveStreamsBridge, type ActiveStreamsClient } from './active-streams';

const JE = chromeBridge<ActiveStreamsBridge>();
const streams = createActiveStreams(JE, () => hostClient<ActiveStreamsClient>());
chromeContext(JE, ['activeStreams']).own.activeStreams = { initialize: streams.initialize, destroy: streams.destroy };
streams.bindSession();

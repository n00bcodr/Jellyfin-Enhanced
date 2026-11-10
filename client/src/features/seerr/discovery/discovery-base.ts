// /js/jellyseerr/discovery/discovery-base.js
// Published as JE.discoveryBase { createDiscovery, idFromDetailUrl, idFromListParam }.
import { discoveryHost } from '../host-discovery';
import { createDiscoveryController } from './controller';
import { parseDetailId, parseListParam } from './domain';

(function () {
    'use strict';
    const { JE } = discoveryHost();
    JE.discoveryBase = {
        createDiscovery: spec => createDiscoveryController(spec, JE),
        idFromDetailUrl: () => parseDetailId(window.location.hash),
        idFromListParam: param => () => parseListParam(window.location.hash, param)
    };
})();

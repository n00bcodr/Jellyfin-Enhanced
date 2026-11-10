import type { Priority } from './types';
import type { RequestMetric } from './retry';
interface Section { startTime: number; endTime: number | null; requestCount: number; totalBytes: number; cacheHits: number }
/** Debug metrics preserve the frozen request-manager shape. */
export function createMetrics(now: () => number, debug: (...values: unknown[]) => void) {
    const metrics: { enabled: boolean; sections: Map<string, Section>; requests: RequestMetric[];
        queueWaits: { priority: Priority; waitMs: number }[] } = {
        enabled: false, sections: new Map(), requests: [], queueWaits: []
    };
    return { metrics,
        startMeasurement(name: string) {
            if (metrics.enabled) metrics.sections.set(name, { startTime: now(), endTime: null, requestCount: 0, totalBytes: 0, cacheHits: 0 });
        },
        recordRequest(name: string, bytes: number, fromCache = false) {
            const section = metrics.sections.get(name);
            if (!metrics.enabled || !section) return;
            section.requestCount++; section.totalBytes += bytes || 0; if (fromCache) section.cacheHits++;
        },
        endMeasurement(name: string) {
            if (!metrics.enabled) return undefined;
            const section = metrics.sections.get(name); if (!section) return null;
            section.endTime = now();
            const result = { ttfr: section.endTime - section.startTime, requests: section.requestCount,
                cacheHits: section.cacheHits, bytes: section.totalBytes };
            debug(`[JE Metrics] ${name}:`, { ...result, ttfr: `${result.ttfr.toFixed(1)}ms`, bytes: `${(result.bytes / 1024).toFixed(1)}KB` });
            return result;
        },
        getMetrics() {
            const sections: Record<string, Section> = {};
            for (const [name, value] of metrics.sections) Object.defineProperty(sections, name, { value: { ...value }, enumerable: true });
            return { sections, requests: metrics.requests.slice(), queueWaits: metrics.queueWaits.slice() };
        },
        resetMetrics() { metrics.sections.clear(); metrics.requests = []; metrics.queueWaits = []; }
    };
}

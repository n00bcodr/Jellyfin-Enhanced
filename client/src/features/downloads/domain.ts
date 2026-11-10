import type { Item, Group } from "./types";
export function groupDownloads(downloads: Item[]) {
    const grouped: Group[] = [];
    const seasonPackMap = new Map<string,Item[]>(); // key: "title|season|progress" -> episodes[]

    for (const item of downloads) {
      // Only group sonarr items with season numbers
      if (item.source === "Sonarr" && item.seasonNumber != null) {
        // Group by show title + season + progress (same progress = likely season pack)
        const key = JSON.stringify([item.source,item.instanceId ?? item.instanceName,item.title,item.seasonNumber,item.progress]);

        if (!seasonPackMap.has(key)) {
          seasonPackMap.set(key, []);
        }
        const bucket=seasonPackMap.get(key);
        if(bucket)bucket.push(item);
      } else {
        // Movies or items without season info - add directly
        grouped.push({ type: "single", item });
      }
    }

    // Process season groups
    for (const [, episodes] of seasonPackMap) {
      if (episodes.length >= 3) {
        // 3+ episodes with same progress = season pack, collapse them
        const first = episodes[0];
        if (!first) continue;
        const episodeNums = episodes
          .map((e) => e.episodeNumber)
          .sort((a, b) => (a || 0) - (b || 0));
        const minEp = episodeNums[0];
        const maxEp = episodeNums[episodeNums.length - 1];

        grouped.push({
          type: "seasonPack",
          item: first,
          episodes: episodes,
          episodeRange: `E${String(minEp).padStart(2, "0")}-E${String(maxEp).padStart(2, "0")}`,
          episodeCount: episodes.length,
        });
      } else {
        // Few episodes - show individually
        for (const ep of episodes) {
          grouped.push({ type: "single", item: ep });
        }
      }
    }

    return grouped;
  }

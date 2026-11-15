#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCatalog,
  canonicalHost,
  isDeadLink,
  mergeCandidates,
  selectCandidatesForProbe,
} from "./catalog.mjs";
import { writeReadOnlyAPI } from "./api-data.mjs";
import { discoverInternetSources } from "./discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicData = path.join(root, "public", "data");
const candidatesPath = path.join(root, "candidates.json");
const exclusionsPath = path.join(root, "exclusions.json");
const submissionsPath = path.join(root, "submissions.json");
const discoverySourcesPath = path.join(root, "discovery-sources.json");
const concurrency = numberEnv("PROBE_CONCURRENCY", 6);
const timeoutMs = numberEnv("PROBE_TIMEOUT_MS", 8000);
const playbackTimeoutMs = numberEnv("PLAYBACK_TIMEOUT_MS", 5000);
const keywords = String(process.env.PROBE_KEYWORDS || "庆余年,三体")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const qualityProbeLimit = numberEnv("QUALITY_PROBE_LIMIT", 18);
const discoveryEnabled = process.env.DISCOVERY !== "off";
const discoveryLimit = numberEnv("DISCOVERY_LIMIT", 240);
const freshDiscoveryReserve = numberEnv("FRESH_DISCOVERY_RESERVE", 40);
const deadLinkAfterDays = numberEnv("DEAD_LINK_AFTER_DAYS", 30);
const bestCandidateLimit = numberEnv("BEST_CANDIDATE_LIMIT", 16);
const adultPattern =
  /色|黄|AV|av|成人|伦理|福利|里番|麻豆|杏吧|美少女|湿乐园|番号|X资源|X站|黑料|约炮|裸|做爱|激情/;
const adultCategoryPattern =
  /成人|里番|无码|自拍|偷拍|主播|三级|乱伦|群交|性爱|美乳|强奸|探花|换脸|重口|丝袜|人妻|熟女|激情|福利姬/;
const catalogURLs = [
  process.env.CATALOG_URL,
  "https://firepick-1302621537.cos.ap-shanghai.myqcloud.com/firepick-monitor/data/catalog.json",
  "https://sources.yychuiyan.com/data/catalog.json",
].filter(Boolean);

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function loadCandidates() {
  const parsedSeeds = await readJSON(candidatesPath);
  const seeds = Array.isArray(parsedSeeds) ? parsedSeeds : parsedSeeds.providers;
  if (!Array.isArray(seeds)) {
    throw new Error("candidates.json must be an array or contain providers[]");
  }
  const submissionsFile = await readJSON(submissionsPath);
  const submissions = Array.isArray(submissionsFile)
    ? submissionsFile
    : submissionsFile.providers || [];
  const exclusions = await loadExclusions();
  const previousCatalog = await loadPreviousCatalog();
  const discoveryConfig = await readJSON(discoverySourcesPath);
  const discovered = discoveryEnabled
    ? await discoverInternetSources(discoveryConfig, {
        githubToken: process.env.GITHUB_TOKEN,
      })
    : [];
  const merged = mergeCandidates({
    seeds,
    catalog: previousCatalog,
    discovered: [
      ...submissions.map((provider) => ({
        ...provider,
        discoverySource: "submission",
      })),
      ...discovered,
    ],
    excluded: [...exclusions],
  });
  console.log(
    `Catalog ${previousCatalog.length}, submissions ${submissions.length}, ` +
      `internet discoveries ${discovered.length}, excluded ${exclusions.size}`
  );
  console.log(`Merged ${merged.length} candidates`);
  return { providers: merged, previousCatalog };
}

async function loadPreviousCatalog() {
  for (const url of catalogURLs) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) continue;
      const data = await response.json();
      const providers = Array.isArray(data) ? data : data.providers;
      if (Array.isArray(providers) && providers.length) return providers;
    } catch {
      // Try the next own snapshot endpoint.
    }
  }
  try {
    const local = await readJSON(path.join(publicData, "catalog.json"));
    if (Array.isArray(local.providers)) return local.providers;
  } catch {
    // First run has no local catalog snapshot.
  }
  return [];
}

async function loadExclusions() {
  const parsed = await readJSON(exclusionsPath);
  const entries = Array.isArray(parsed) ? parsed : parsed.excluded;
  if (!Array.isArray(entries)) {
    throw new Error("exclusions.json must be an array or contain excluded[]");
  }
  return new Set(
    entries
      .map((entry) => canonicalHost(entry?.host || entry?.api))
      .filter(Boolean)
  );
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function endpoint(api, params) {
  const url = new URL(api);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function requestJSON(api, params, timeout = timeoutMs) {
  const started = Date.now();
  const attempts = [
    ["okhttp/4.1.0", "application/json,text/plain,*/*"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36",
      "application/json,text/plain,text/html,*/*",
    ],
  ];
  let lastError = null;
  for (const [userAgent, accept] of attempts) {
    try {
      const response = await fetch(endpoint(api, params), {
        headers: { "User-Agent": userAgent, Accept: accept },
        signal: AbortSignal.timeout(timeout),
      });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`non-json HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { data, ms: Date.now() - started, status: response.status };
    } catch (error) {
      lastError = error;
      if (!/HTTP (?:401|403)|non-json HTTP (?:401|403)/.test(String(error.message))) {
        break;
      }
    }
  }
  throw lastError;
}

function firstPlayableURL(detail) {
  if (!detail) return "";
  const groups = String(detail.vod_play_url || "").split("$$$");
  for (const group of groups) {
    for (const episode of group.split("#")) {
      const separator = episode.indexOf("$");
      const value = separator >= 0 ? episode.slice(separator + 1) : episode;
      if (/^https?:\/\//i.test(value)) return value;
    }
  }
  return "";
}

function parseVariants(playlist) {
  const profiles = [];
  for (const line of playlist.split(/\r?\n/)) {
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    const bandwidth = line.match(/BANDWIDTH=(\d+)/i);
    if (!resolution) continue;
    profiles.push({
      width: Number(resolution[1]),
      height: Number(resolution[2]),
      bandwidth: bandwidth ? Number(bandwidth[1]) : 0
    });
  }
  return profiles.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)[0] || null;
}

async function inspectPlayback(stream) {
  if (!stream) return { stream: "", hls: false, quality: null };
  const lower = stream.toLowerCase();
  if (!lower.includes(".m3u8")) {
    return { stream, hls: false, quality: null };
  }
  try {
    const started = Date.now();
    const response = await fetch(stream, {
      headers: {
        "User-Agent": "okhttp/4.1.0",
        Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*"
      },
      signal: AbortSignal.timeout(playbackTimeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      return { stream, hls: true, quality: null, error: `HTTP ${response.status}` };
    }
    return {
      stream,
      hls: true,
      playlistMs: Date.now() - started,
      quality: parseVariants(text)
    };
  } catch (error) {
    return { stream, hls: true, quality: null, error: String(error.name || error) };
  }
}

function qualityTier(height) {
  if (height >= 2000) return 4;
  if (height >= 1400) return 3;
  if (height >= 1000) return 2;
  if (height >= 700) return 1;
  return 0;
}

function score(result) {
  let value = 0;
  if (result.listOK) value += 25;
  value += Math.min(20, result.searchHits * 4);
  if (result.detailOK) value += 15;
  if (result.streamOK) value += 15;
  value += qualityTier(
    result.quality ? Math.min(result.quality.width, result.quality.height) : 0
  ) * 8;
  if (result.quality?.bandwidth >= 2_000_000) value += 4;
  if (result.listMs > 0) value += Math.max(0, 8 - Math.min(8, result.listMs / 500));
  if (result.rating > 0) value += Math.min(4, result.rating * 0.8);
  return Math.round(value * 10) / 10;
}

async function probe(provider, index) {
  const metadata = provider.metadata || {};
  const result = {
    key: provider.key,
    name: provider.name,
    api: provider.api,
    adult:
      Boolean(provider.adult)
      || Boolean(metadata.adult)
      || adultPattern.test(
        [provider.name, metadata.description, ...(metadata.tags || [])].join(" ")
      ),
    discovered: Boolean(provider.discovered),
    discoverySource: provider.discoverySource || "seed",
    sourceURL: metadata.sourceURL || "",
    apiType: metadata.apiType || null,
    description: metadata.description || "",
    tags: metadata.tags || [],
    rating: metadata.rating || 0,
    directoryStatus: metadata.directoryStatus || null,
    uptime: metadata.uptime,
    directoryResponseTime: metadata.responseTime,
    updateFrequency: metadata.updateFrequency || null,
    resourceCount: metadata.resourceCount,
    lastUpdateTime: metadata.lastUpdateTime || null,
    lastResourceUpdate: metadata.lastResourceUpdate || null,
    establishedAt: metadata.establishedAt || null,
    todayUpdates: metadata.todayUpdates || 0,
    directorySpeed: metadata.speed || null,
    listOK: false,
    listMs: 0,
    httpStatus: null,
    searchHits: 0,
    searchMs: 0,
    detailOK: false,
    streamOK: false,
    hls: false,
    quality: null,
    error: null
  };
  try {
    const list = await requestJSON(provider.api, { ac: "videolist", pg: 1 });
    result.listOK = Array.isArray(list.data?.list) && list.data.list.length > 0;
    result.listMs = list.ms;
    result.httpStatus = list.status;
    const total = Number(list.data?.total);
    const pages = Number(list.data?.pagecount);
    const limit = Number(list.data?.limit);
    result.resourceCount =
      (Number.isFinite(total) && total > 0 && total) ||
      (Number.isFinite(pages) &&
        pages > 0 &&
        Number.isFinite(limit) &&
        limit > 0 &&
        Math.round(pages * limit)) ||
      list.data?.list?.length ||
      result.resourceCount;
    if (!result.listOK) throw new Error("empty list");

    if (!result.adult) {
      try {
        const catalog = await requestJSON(provider.api, { ac: "list" }, timeoutMs);
        const adultCategoryHits = (Array.isArray(catalog.data?.class) ? catalog.data.class : [])
          .map((item) => String(item?.type_name || ""))
          .filter((name) => adultCategoryPattern.test(name));
        result.adult = adultCategoryHits.length >= 3;
      } catch {
        // Catalog classification is best-effort; explicit directory markers remain authoritative.
      }
    }

    let matched = null;
    for (const keyword of keywords) {
      try {
        const search = await requestJSON(
          provider.api,
          { ac: "videolist", wd: keyword, pg: 1 },
          timeoutMs
        );
        result.searchMs = Math.max(result.searchMs, search.ms);
        const hits = Array.isArray(search.data?.list) ? search.data.list : [];
        result.searchHits += hits.length;
        matched ||=
          hits.find((item) =>
            String(item.vod_name || "").toLowerCase().includes(keyword.toLowerCase())
          ) || hits[0] || null;
      } catch {
        // Keep trying other keywords; one successful query is enough for detail.
      }
    }
    if (!matched?.vod_id) throw new Error("search miss");

    const detail = await requestJSON(provider.api, {
      ac: "detail",
      ids: String(matched.vod_id)
    });
    const item = Array.isArray(detail.data?.list) ? detail.data.list[0] : null;
    result.detailOK = Boolean(item?.vod_id);
    if (!result.detailOK) throw new Error("empty detail");

    const stream = firstPlayableURL(item);
    result.streamOK = Boolean(stream);
    if (stream && index < qualityProbeLimit) {
      const playback = await inspectPlayback(stream);
      result.hls = playback.hls;
      result.quality = playback.quality;
      if (playback.error) result.error = playback.error;
    }
  } catch (error) {
    result.error = String(error.message || error.name || error);
  }
  result.online = result.listOK && result.searchHits > 0 && result.detailOK && result.streamOK;
  result.score = score(result);
  return result;
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function writeJSON(name, value) {
  await fs.writeFile(
    path.join(publicData, name),
    JSON.stringify(value, null, 2) + "\n"
  );
}

const { providers: mergedCandidates, previousCatalog } = await loadCandidates();
const selection = selectCandidatesForProbe({
  merged: mergedCandidates,
  catalog: previousCatalog,
  limit: discoveryLimit,
  freshReserve: freshDiscoveryReserve,
  deadAfterDays: deadLinkAfterDays,
});
const candidates = selection.items;
console.log(
  `Selected ${selection.stats.selected}/${selection.stats.merged} candidates ` +
    `(fresh ${selection.stats.freshSelected}/${selection.stats.freshAvailable}, ` +
    `dead skipped ${selection.stats.deadSkipped}, reserve ${freshDiscoveryReserve})`
);
const results = await mapLimit(candidates, concurrency, probe);
const previousByHost = new Map(
  previousCatalog.map((item) => [canonicalHost(item.api), item])
);
for (const result of results) {
  const previous = previousByHost.get(canonicalHost(result.api));
  const history = previous?.history || {};
  const previousOnline = Number(history.onlineCount || 0);
  const previousOffline = Number(history.offlineCount || 0);
  const onlineChecks = previousOnline + (result.online ? 1 : 0);
  const offlineChecks = previousOffline + (result.online ? 0 : 1);
  const samples = onlineChecks + offlineChecks;
  result.uptime = samples ? Math.round((onlineChecks / samples) * 1000) / 10 : null;
  result.uptimeSamples = samples;
  result.onlineChecks = onlineChecks;
  result.offlineChecks = offlineChecks;
  result.resourceCount = result.resourceCount || previous?.resourceCount || null;
}
const online = results.filter((item) => item.online);
const offline = results.filter((item) => !item.online);
const discoverySourceStats = {};
for (const item of results) {
  if (!item.discovered) continue;
  const source = item.discoverySource || "unknown";
  const stats = (discoverySourceStats[source] ||= { total: 0, online: 0 });
  stats.total += 1;
  if (item.online) stats.online += 1;
}
const ranked = [...results].sort((a, b) => b.score - a.score);
const quality = ranked
  .filter((item) => item.online && item.quality?.height > 0)
  .sort(
    (a, b) =>
      Math.min(b.quality.width, b.quality.height) -
        Math.min(a.quality.width, a.quality.height) ||
      b.quality.width * b.quality.height - a.quality.width * a.quality.height ||
      b.quality.bandwidth - a.quality.bandwidth ||
      b.score - a.score
  );
const generatedAt = new Date().toISOString();
const fastest = online
  .filter((item) => item.listMs > 0)
  .sort((a, b) => a.listMs - b.listMs)
  .slice(0, 20);
const topRated = results
  .filter((item) => item.rating > 0)
  .sort((a, b) => b.rating - a.rating || b.score - a.score)
  .slice(0, 20);
const bestHosts = new Set();
const bestEligible = ranked.filter((item) => {
  if (!item.online) return false;
  const host = canonicalHost(item.api);
  if (bestHosts.has(host)) return false;
  bestHosts.add(host);
  return true;
});
const generalBestTarget = Math.min(12, bestCandidateLimit);
const best = [
  ...bestEligible.filter((item) => !item.adult).slice(0, generalBestTarget),
  ...bestEligible
    .filter((item) => item.adult)
    .slice(0, Math.max(0, bestCandidateLimit - generalBestTarget)),
];
const selectedBestKeys = new Set(best.map((item) => item.key));
for (const item of bestEligible) {
  if (best.length >= bestCandidateLimit) break;
  if (selectedBestKeys.has(item.key)) continue;
  best.push(item);
  selectedBestKeys.add(item.key);
}
const listTimes = results.filter((item) => item.listMs > 0).map((item) => item.listMs);
const average = (values) =>
  values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : 0;

await fs.mkdir(publicData, { recursive: true });
const latest = {
  generatedAt,
  keywords,
  total: results.length,
  onlineCount: online.length,
  offlineCount: offline.length,
  discoveredCount: results.filter((item) => item.discovered).length,
  results
};
await writeJSON("latest.json", latest);
await fs.writeFile(
  path.join(publicData, "latest.js"),
  `window.__FIREPICK_LATEST__ = ${JSON.stringify(latest)};\n`
);
await writeJSON("online.json", {
  generatedAt,
  count: online.length,
  providers: online.map(({ error, ...provider }) => provider)
});
await writeJSON("offline.json", {
  generatedAt,
  count: offline.length,
  providers: offline
});
await writeJSON("quality.json", {
  generatedAt,
  count: quality.length,
  providers: quality
});
await writeJSON("cms-candidates.json", {
  generatedAt,
  providers: online
    .sort((a, b) => b.score - a.score)
    .map(({ key, name, api, adult }) => ({ key, name, api, adult }))
});
await writeJSON("fastest.json", {
  generatedAt,
  count: fastest.length,
  providers: fastest
});
await writeJSON("top-rated.json", {
  generatedAt,
  count: topRated.length,
  providers: topRated
});
const bestPayload = {
  schemaVersion: 1,
  generatedAt,
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  count: best.length,
  providers: best.map(
    ({ key, name, api, adult, score, listMs, uptime, rating, quality, todayUpdates }) => ({
      key,
      name,
      api,
      adult,
      score,
      listMs,
      uptime,
      rating,
      quality,
      todayUpdates
    })
  )
};
await writeJSON("best.json", bestPayload);
const statsPayload = {
  generatedAt,
  total: results.length,
  online: online.length,
  offline: offline.length,
  onlineRate:
    results.length > 0
      ? Math.round((online.length / results.length) * 1000) / 10
      : 0,
  discovered: results.filter((item) => item.discovered).length,
  averageListMs: average(listTimes),
  fastestListMs: listTimes.length ? Math.min(...listTimes) : 0,
  slowestListMs: listTimes.length ? Math.max(...listTimes) : 0,
  withResolution: quality.length,
  with1080p: quality.filter(
    (item) => Math.min(item.quality.width, item.quality.height) >= 1000
  ).length,
  withRating: results.filter((item) => item.rating > 0).length,
  discoverySources: discoverySourceStats,
  candidateSelection: selection.stats,
};
await writeJSON("stats.json", statsPayload);

const activeCatalog = buildCatalog(results, previousCatalog, generatedAt);
const activeHosts = new Set(
  activeCatalog.map((item) => canonicalHost(item.api)).filter(Boolean)
);
const archivedCatalog = previousCatalog
  .filter((item) => !activeHosts.has(canonicalHost(item.api)))
  .map((item) => ({
    ...item,
    monitoringState: isDeadLink(item, {
      now: generatedAt,
      deadAfterDays: deadLinkAfterDays,
    })
      ? "dead"
      : "rotating",
    archivedAt: generatedAt,
  }));
const catalog = [...activeCatalog, ...archivedCatalog].sort(
  (a, b) =>
    Number(b.status === "online") - Number(a.status === "online") ||
    Number(b.score || 0) - Number(a.score || 0)
);
await writeJSON("catalog.json", {
  schemaVersion: 1,
  generatedAt,
  count: catalog.length,
  online: catalog.filter((item) => item.status === "online").length,
  dead: catalog.filter((item) => item.monitoringState === "dead").length,
  archived: catalog.filter((item) => item.monitoringState === "rotating").length,
  providers: catalog,
});
await writeJSON("archive.json", {
  generatedAt,
  count: archivedCatalog.length,
  dead: archivedCatalog.filter((item) => item.monitoringState === "dead").length,
  providers: archivedCatalog,
});
await writeReadOnlyAPI({
  root,
  generatedAt,
  catalog,
  best: bestPayload,
  stats: statsPayload,
});

console.log(`Online ${online.length}/${results.length}; quality ${quality.length}`);
console.log(
  `Archive ${archivedCatalog.length}; dead ${
    catalog.filter((item) => item.monitoringState === "dead").length
  }`
);
console.log(
  `Discovery ${JSON.stringify(discoverySourceStats)}`
);
for (const item of quality.slice(0, 12)) {
  console.log(
    `  ★ ${item.key} ${item.quality.width}x${item.quality.height} ` +
      `${Math.round(item.quality.bandwidth / 1000)}kbps score=${item.score}`
  );
}

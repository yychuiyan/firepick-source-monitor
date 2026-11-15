#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicData = path.join(root, "public", "data");
const candidatesPath = path.join(root, "candidates.json");
const concurrency = numberEnv("PROBE_CONCURRENCY", 6);
const timeoutMs = numberEnv("PROBE_TIMEOUT_MS", 8000);
const playbackTimeoutMs = numberEnv("PLAYBACK_TIMEOUT_MS", 5000);
const keywords = String(process.env.PROBE_KEYWORDS || "庆余年,三体")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const qualityProbeLimit = numberEnv("QUALITY_PROBE_LIMIT", 18);

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function loadCandidates() {
  const parsed = JSON.parse(await fs.readFile(candidatesPath, "utf8"));
  const providers = Array.isArray(parsed) ? parsed : parsed.providers;
  if (!Array.isArray(providers)) {
    throw new Error("candidates.json must be an array or contain providers[]");
  }
  const seen = new Set();
  return providers.filter((provider) => {
    if (!provider?.key || !provider?.name || !provider?.api) return false;
    const host = URL.canParse(provider.api) ? new URL(provider.api).host : provider.key;
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
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
  const response = await fetch(endpoint(api, params), {
    headers: {
      "User-Agent": "okhttp/4.1.0",
      Accept: "application/json,text/plain,*/*"
    },
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`non-json HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { data, ms: Date.now() - started };
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
  return Math.round(value * 10) / 10;
}

async function probe(provider, index) {
  const result = {
    key: provider.key,
    name: provider.name,
    api: provider.api,
    listOK: false,
    listMs: 0,
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
    if (!result.listOK) throw new Error("empty list");

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

const candidates = await loadCandidates();
console.log(`Probing ${candidates.length} candidates...`);
const results = await mapLimit(candidates, concurrency, probe);
const online = results.filter((item) => item.online);
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

await fs.mkdir(publicData, { recursive: true });
const latest = {
  generatedAt,
  keywords,
  total: results.length,
  onlineCount: online.length,
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
await writeJSON("quality.json", {
  generatedAt,
  count: quality.length,
  providers: quality
});
await writeJSON("cms-candidates.json", {
  generatedAt,
  providers: online
    .sort((a, b) => b.score - a.score)
    .map(({ key, name, api }) => ({ key, name, api }))
});
await writeJSON("stats.json", {
  generatedAt,
  total: results.length,
  online: online.length,
  offline: results.length - online.length,
  withResolution: quality.length,
  with1080p: quality.filter(
    (item) => Math.min(item.quality.width, item.quality.height) >= 1000
  ).length
});

console.log(`Online ${online.length}/${results.length}; quality ${quality.length}`);
for (const item of quality.slice(0, 12)) {
  console.log(
    `  ★ ${item.key} ${item.quality.width}x${item.quality.height} ` +
      `${Math.round(item.quality.bandwidth / 1000)}kbps score=${item.score}`
  );
}

const API_PATH_PATTERN =
  /(?:\/api\.php(?:\/|$)|\/provide\/vod(?:\/|$)|\/apijson\.php(?:\/|$)|\/json\.php(?:\/|$)|\/api\/json(?:\/|$))/i;

export function canonicalHost(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text).host.toLowerCase();
  } catch {
    return text.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  }
}

export function normalizeAPI(value) {
  let text = String(value || "")
    .trim()
    .replace(/\\u002f/gi, "/")
    .replace(/\\+\//g, "/")
    .replace(/&amp;/gi, "&");
  text = text.replace(/[),.;\]}]+$/g, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const path = url.pathname.toLowerCase();
  if (!API_PATH_PATTERN.test(path)) return null;
  if (/\.(?:m3u8|mp4|jpg|jpeg|png|webp|gif|svg|css|js)$/i.test(path)) {
    return null;
  }
  for (const key of ["ac", "wd", "pg", "ids"]) url.searchParams.delete(key);
  url.hash = "";
  return url.toString();
}

export function extractAPIEndpoints(text) {
  const source = String(text || "")
    .replace(/\\u002f/gi, "/")
    .replace(/\\+\//g, "/")
    .replace(/&amp;/gi, "&");
  const matches = source.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  const endpoints = [];
  const seen = new Set();
  for (const match of matches) {
    const endpoint = normalizeAPI(match);
    if (!endpoint) continue;
    const key = endpoint.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push(endpoint);
  }
  return endpoints;
}

export function candidateKey(host) {
  return String(host || "")
    .replace(/^www\./i, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 48);
}

export function mergeCandidates({ seeds = [], catalog = [], discovered = [], excluded = [] }) {
  const excludedHosts = new Set(excluded.map((item) => canonicalHost(item?.host || item)));
  const seen = new Set();
  const catalogByHost = new Map();
  for (const item of catalog) {
    const host = canonicalHost(item?.api);
    if (host) catalogByHost.set(host, item);
  }

  const merged = [];
  const append = (item, source) => {
    if (!item?.api) return;
    const api = normalizeAPI(item.api) || item.api;
    const host = canonicalHost(api);
    if (!host || excludedHosts.has(host) || seen.has(host)) return;
    seen.add(host);
    const previous = catalogByHost.get(host);
    const previousMetadata = previous
      ? {
          adult: previous.adult,
          sourceURL: previous.sourceURL,
          apiType: previous.apiType,
          description: previous.description,
          tags: previous.tags,
          rating: previous.rating,
          directoryStatus: previous.directoryStatus,
          uptime: previous.uptime,
          responseTime: previous.responseTime,
          updateFrequency: previous.updateFrequency,
          resourceCount: previous.resourceCount,
          lastUpdateTime: previous.lastUpdateTime,
          lastResourceUpdate: previous.lastResourceUpdate,
        }
      : {};
    merged.push({
      ...previous,
      ...item,
      key: item.key || previous?.key || candidateKey(host),
      name: item.name || previous?.name || host,
      api,
      metadata: {
        ...previousMetadata,
        ...(previous?.metadata || {}),
        ...(item.metadata || {}),
      },
      discoverySource: item.discoverySource || source,
      discovered: source !== "seed",
    });
  };

  for (const item of seeds) append(item, "seed");
  for (const item of catalog) append(item, "catalog");
  for (const item of discovered) append(item, "internet");
  return merged;
}

export function isDeadLink(
  source,
  {
    now = new Date(),
    deadAfterDays = 30,
    minimumOfflineChecks = 3,
  } = {}
) {
  if (source?.status === "online") return false;
  const offlineChecks = Number(source?.history?.offlineCount || 0);
  if (offlineChecks < minimumOfflineChecks) return false;
  const lastOnline =
    source?.lastOnlineAt ||
    source?.history?.lastOnlineAt ||
    source?.firstSeenAt ||
    source?.lastCheckedAt;
  if (!lastOnline) return false;
  const lastOnlineTime = new Date(lastOnline).getTime();
  const nowTime = new Date(now).getTime();
  if (!Number.isFinite(lastOnlineTime) || !Number.isFinite(nowTime)) return false;
  return nowTime - lastOnlineTime >= deadAfterDays * 24 * 60 * 60 * 1000;
}

export function selectCandidatesForProbe({
  merged = [],
  catalog = [],
  limit = 240,
  freshReserve = 40,
  now = new Date(),
  deadAfterDays = 30,
}) {
  const catalogByHost = new Map(
    catalog.map((item) => [canonicalHost(item?.api), item]).filter(([host]) => host)
  );
  const fixed = [];
  const online = [];
  const fresh = [];
  const recentOffline = [];
  const dead = [];

  for (const item of merged) {
    const previous = catalogByHost.get(canonicalHost(item?.api));
    if (item.discoverySource === "seed") {
      fixed.push(item);
    } else if (previous?.status === "online") {
      online.push(item);
    } else if (!previous) {
      fresh.push(item);
    } else if (isDeadLink(previous, { now, deadAfterDays })) {
      dead.push(item);
    } else {
      recentOffline.push(item);
    }
  }

  recentOffline.sort(
    (a, b) =>
      timestamp(
        catalogByHost.get(canonicalHost(b.api))?.lastOnlineAt ||
          catalogByHost.get(canonicalHost(b.api))?.history?.lastOnlineAt
      ) -
        timestamp(
          catalogByHost.get(canonicalHost(a.api))?.lastOnlineAt ||
            catalogByHost.get(canonicalHost(a.api))?.history?.lastOnlineAt
        ) ||
      Number(catalogByHost.get(canonicalHost(b.api))?.score || 0) -
        Number(catalogByHost.get(canonicalHost(a.api))?.score || 0)
  );

  const selected = [];
  const selectedHosts = new Set();
  const add = (item) => {
    const host = canonicalHost(item?.api);
    if (!host || selectedHosts.has(host)) return false;
    selectedHosts.add(host);
    selected.push(item);
    return true;
  };

  fixed.forEach(add);
  online.forEach(add);
  const freshQuota = Math.max(0, Math.min(freshReserve, limit - selected.length));
  fresh.slice(0, freshQuota).forEach(add);
  recentOffline
    .slice(0, Math.max(0, limit - selected.length))
    .forEach(add);
  // If there are not enough recent lines, use additional new candidates.
  if (selected.length < limit) {
    fresh.slice(freshQuota, freshQuota + limit - selected.length).forEach(add);
  }

  return {
    items: selected,
    stats: {
      limit,
      freshReserve,
      merged: merged.length,
      selected: selected.length,
      fixed: fixed.length,
      online: online.length,
      freshAvailable: fresh.length,
      freshSelected: selected.filter((item) => fresh.includes(item)).length,
      recentOffline: recentOffline.length,
      deadSkipped: dead.length,
    },
  };
}

export function buildCatalog(results, previousCatalog = [], generatedAt = new Date().toISOString()) {
  const previousByHost = new Map(
    previousCatalog.map((item) => [canonicalHost(item?.api), item])
  );
  return results
    .map((result) => {
      const previous = previousByHost.get(canonicalHost(result.api)) || {};
      const history = previous.history || {};
      const onlineCount =
        Number(history.onlineCount || 0) + (result.online === true ? 1 : 0);
      const offlineCount =
        Number(history.offlineCount || 0) + (result.online === true ? 0 : 1);
      const entry = {
        key: result.key,
        name: result.name,
        api: result.api,
        adult: Boolean(result.adult),
        discovered: Boolean(result.discovered),
        discoverySource: result.discoverySource || previous.discoverySource || "seed",
        sourceURL: result.sourceURL || previous.sourceURL || "",
        apiType: result.apiType || previous.apiType || null,
        description: result.description || previous.description || "",
        tags: result.tags || previous.tags || [],
        rating: result.rating || previous.rating || 0,
        directoryStatus: result.directoryStatus || previous.directoryStatus || null,
        uptime: result.uptime ?? previous.uptime ?? null,
        responseTime:
          result.directoryResponseTime ?? previous.responseTime ?? result.listMs ?? null,
        updateFrequency: result.updateFrequency || previous.updateFrequency || null,
        resourceCount: result.resourceCount ?? previous.resourceCount ?? null,
        lastUpdateTime: result.lastUpdateTime || previous.lastUpdateTime || null,
        lastResourceUpdate:
          result.lastResourceUpdate || previous.lastResourceUpdate || null,
        firstSeenAt: previous.firstSeenAt || generatedAt,
        lastCheckedAt: generatedAt,
        lastOnlineAt: result.online
          ? generatedAt
          : previous.lastOnlineAt || previous.history?.lastOnlineAt || null,
        lastOfflineAt: result.online
          ? previous.lastOfflineAt || previous.history?.lastOfflineAt || null
          : generatedAt,
        status: result.online ? "online" : "offline",
        score: result.score,
        latencyMs: result.listMs,
        searchMs: result.searchMs,
        httpStatus: result.httpStatus,
        quality: result.quality,
        error: result.error,
        history: {
          onlineCount,
          offlineCount,
          lastOnlineAt: result.online
            ? generatedAt
            : previous.lastOnlineAt || previous.history?.lastOnlineAt || null,
          lastOfflineAt: result.online
            ? previous.lastOfflineAt || previous.history?.lastOfflineAt || null
            : generatedAt,
        },
      };
      entry.monitoringState =
        entry.status === "online"
          ? "online"
          : isDeadLink(entry, { now: generatedAt })
            ? "dead"
            : "recent-offline";
      return entry;
    })
    .sort((a, b) => Number(b.online || 0) - Number(a.online || 0) || b.score - a.score);
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

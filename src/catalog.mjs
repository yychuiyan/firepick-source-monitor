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
      return {
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
    })
    .sort((a, b) => Number(b.online || 0) - Number(a.online || 0) || b.score - a.score);
}

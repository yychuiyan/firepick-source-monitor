const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=60",
};

export default {
  async fetch(request, env) {
    return handleAPIRequest(request, {
      loadJSON: (pathname) => loadAssetJSON(request, env, pathname),
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchMonitorWorkflow(fetch, env));
  },
};

export async function dispatchMonitorWorkflow(fetchImpl = fetch, env = {}) {
  const token = String(env.GITHUB_DISPATCH_TOKEN || "").trim();
  if (!token) {
    console.error("GITHUB_DISPATCH_TOKEN is not configured");
    return false;
  }
  const repository = String(
    env.GITHUB_REPOSITORY || "yychuiyan/firepick-source-monitor"
  ).trim();
  const ref = String(env.GITHUB_REF_NAME || "main").trim() || "main";
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/actions/workflows/monitor.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "firepick-source-monitor-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref }),
    }
  );
  if (!response.ok) {
    console.error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
  }
  return response.ok;
}

export async function handleAPIRequest(request, { loadJSON }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/api/v1" || pathname === "/api" || pathname === "/api/") {
    return json({
      apiVersion: "v1",
      name: "拾萤资源组 API",
      endpoints: [
        "/api/v1/sources",
        "/api/v1/sources/{id}",
        "/api/v1/search?q=",
        "/api/v1/monitor",
        "/api/v1/best?mode=standard",
        "/api/v1/defunct",
        "/api/v1/tags",
        "/api/v1/stats",
        "/api/v1/openapi.json",
      ],
    });
  }
  if (/^\/api\/v1\/.+\.json$/i.test(pathname)) {
    try {
      return json(await loadJSON(pathname));
    } catch (error) {
      return json(
        { error: "not_found", message: String(error?.message || error) },
        404
      );
    }
  }

  try {
    if (pathname === "/api/v1/sources") {
      const catalog = await loadCatalog(loadJSON);
      return json(querySources(catalog.sources, url.searchParams));
    }
    if (pathname === "/api/v1/search") {
      const catalog = await loadCatalog(loadJSON);
      if (!url.searchParams.get("q")?.trim()) {
        return json({ error: "missing_query", message: "q 参数不能为空" }, 400);
      }
      return json(querySources(catalog.sources, url.searchParams));
    }
    if (pathname.startsWith("/api/v1/sources/")) {
      const id = decodeURIComponent(pathname.slice("/api/v1/sources/".length));
      const catalog = await loadCatalog(loadJSON);
      const source = catalog.sources.find(
        (item) =>
          item.id === id ||
          item.api === id ||
          host(item.api) === id.toLowerCase()
      );
      if (!source) return json({ error: "not_found", message: "采集站不存在" }, 404);
      return json({
        apiVersion: "v1",
        generatedAt: catalog.generatedAt,
        source,
      });
    }
    if (pathname === "/api/v1/monitor") {
      const catalog = await loadCatalog(loadJSON);
      const sources = catalog.sources.map(
        ({ id, name, api, status, latencyMs, lastCheckedAt, error }) => ({
          id,
          name,
          api,
          status,
          latencyMs,
          lastCheckedAt,
          error,
        })
      );
      return json({
        apiVersion: "v1",
        generatedAt: catalog.generatedAt,
        online: sources.filter((item) => item.status === "online").length,
        offline: sources.filter((item) => item.status === "offline").length,
        sources,
      });
    }
    if (pathname === "/api/v1/defunct") {
      const catalog = await loadCatalog(loadJSON);
      const sources = catalog.sources.filter((item) => item.status === "offline");
      return json({
        apiVersion: "v1",
        generatedAt: catalog.generatedAt,
        count: sources.length,
        sources,
      });
    }
    if (pathname === "/api/v1/tags") {
      const catalog = await loadCatalog(loadJSON);
      return json(buildTags(catalog.sources, catalog.generatedAt));
    }
    if (pathname === "/api/v1/stats") {
      return json(await loadJSON("/api/v1/stats.json"));
    }
    if (pathname === "/api/v1/best") {
      const best = await loadJSON("/api/v1/best.json");
      const mode = String(url.searchParams.get("mode") || "").toLowerCase();
      if (mode !== "standard" && mode !== "adult") return json(best);
      const sources =
        mode === "standard"
          ? best.sources.filter((item) => item.adult !== true)
          : best.sources;
      return json({ ...best, mode, count: sources.length, sources });
    }
    if (pathname === "/api/v1/openapi.json") {
      return json(await loadJSON("/api/v1/openapi.json"));
    }
  } catch (error) {
    return json(
      {
        error: "catalog_unavailable",
        message: String(error?.message || error),
      },
      503
    );
  }

  return json({ error: "not_found", message: "API 路径不存在" }, 404);
}

export function querySources(sources, searchParams) {
  const query = String(searchParams.get("q") || "").trim().toLowerCase();
  const status = String(searchParams.get("status") || "").trim().toLowerCase();
  const adult = searchParams.get("adult");
  const tag = String(searchParams.get("tag") || "").trim().toLowerCase();
  const sort = String(searchParams.get("sort") || "score").toLowerCase();
  const order = String(
    searchParams.get("order") ||
      (sort === "latency" || sort === "latencyms" ? "asc" : "desc")
  ).toLowerCase();
  const page = clampInteger(searchParams.get("page"), 1, 100000, 1);
  const limit = clampInteger(searchParams.get("limit"), 1, 100, 50);

  let filtered = sources.filter((source) => {
    if (status && source.status !== status) return false;
    if (adult === "true" && source.adult !== true) return false;
    if (adult === "false" && source.adult === true) return false;
    if (
      tag &&
      !(source.tags || []).some((value) => String(value).toLowerCase() === tag)
    ) {
      return false;
    }
    if (!query) return true;
    return [source.id, source.name, source.api, source.description, ...(source.tags || [])]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  const direction = order === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    let result = 0;
    if (sort === "latency" || sort === "latencyms") {
      result = number(a.latencyMs) - number(b.latencyMs);
    } else if (sort === "uptime") {
      result = uptime(a) - uptime(b);
    } else if (sort === "name") {
      result = String(a.name).localeCompare(String(b.name), "zh-CN");
    } else if (sort === "checked" || sort === "lastchecked") {
      result = String(a.lastCheckedAt).localeCompare(String(b.lastCheckedAt));
    } else {
      result = number(a.score) - number(b.score);
    }
    return result * direction;
  });

  const total = filtered.length;
  const start = (page - 1) * limit;
  return {
    apiVersion: "v1",
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    sources: filtered.slice(start, start + limit),
  };
}

function uptime(source) {
  const online = number(source.history?.onlineCount);
  const offline = number(source.history?.offlineCount);
  return online + offline ? online / (online + offline) : 0;
}

function buildTags(sources, generatedAt) {
  const counts = new Map();
  for (const source of sources) {
    for (const tag of source.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return {
    apiVersion: "v1",
    generatedAt,
    tags: [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN")),
  };
}

async function loadCatalog(loadJSON) {
  const catalog = await loadJSON("/api/v1/sources.json");
  return {
    ...catalog,
    sources: Array.isArray(catalog.sources) ? catalog.sources : [],
  };
}

async function loadAssetJSON(request, env, pathname) {
  if (!env?.ASSETS?.fetch) throw new Error("ASSETS binding is unavailable");
  const response = await env.ASSETS.fetch(new URL(pathname, request.url));
  if (!response.ok) throw new Error(`asset ${pathname} returned ${response.status}`);
  return await response.json();
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: jsonHeaders,
  });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function host(api) {
  try {
    return new URL(api).host.toLowerCase();
  } catch {
    return "";
  }
}

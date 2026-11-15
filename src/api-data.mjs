import fs from "node:fs/promises";
import path from "node:path";

export async function writeReadOnlyAPI({
  root,
  generatedAt,
  catalog,
  best,
  stats,
}) {
  const apiRoot = path.join(root, "public", "api", "v1");
  await fs.rm(apiRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(apiRoot, "source"), { recursive: true });

  const sourceList = catalog.map((source) => ({
    id: source.key,
    name: source.name,
    api: source.api,
    status: source.status,
    adult: Boolean(source.adult),
    score: source.score,
    latencyMs: source.latencyMs,
    quality: source.quality,
    rating: source.rating,
    resourceCount: source.resourceCount,
    todayUpdates: source.todayUpdates || 0,
    tags: source.tags || [],
    description: source.description || "",
    firstSeenAt: source.firstSeenAt,
    lastCheckedAt: source.lastCheckedAt,
    lastOnlineAt: source.lastOnlineAt,
    lastOfflineAt: source.lastOfflineAt,
    monitoringState: source.monitoringState || null,
    archivedAt: source.archivedAt || null,
    history: source.history,
    discoverySource: source.discoverySource,
    error: source.status === "online" ? null : source.error,
  }));
  const onlineProviders = sourceList
    .filter((source) => source.status === "online")
    .map(({ id, name, api, adult }) => ({
      key: id,
      name,
      api,
      adult,
    }));
  const sourcesPayload = {
    apiVersion: "v1",
    generatedAt,
    count: sourceList.length,
    providers: sourceList.map(({ id, name, api, adult }) => ({
      key: id,
      name,
      api,
      adult,
    })),
    sources: sourceList,
  };
  const monitorPayload = {
    apiVersion: "v1",
    generatedAt,
    online: sourceList.filter((source) => source.status === "online").length,
    offline: sourceList.filter((source) => source.status === "offline").length,
    sources: sourceList.map(
      ({ id, name, api, status, latencyMs, lastCheckedAt, error }) => ({
        id,
        name,
        api,
        status,
        latencyMs,
        lastCheckedAt,
        error,
      })
    ),
  };
  const defunctPayload = {
    apiVersion: "v1",
    generatedAt,
    count: sourceList.filter((source) => source.status === "offline").length,
    sources: sourceList.filter((source) => source.status === "offline"),
  };
  const tagCounts = new Map();
  for (const source of sourceList) {
    for (const tag of source.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const tagsPayload = {
    apiVersion: "v1",
    generatedAt,
    tags: [...tagCounts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN")),
  };
  const bestPayload = {
    apiVersion: "v1",
    ...best,
    sources: best.providers,
  };
  const openapiPayload = buildOpenAPI(generatedAt);

  const write = (relativePath, value) =>
    fs.writeFile(
      path.join(apiRoot, relativePath),
      `${JSON.stringify(value, null, 2)}\n`
    );

  await write("sources.json", sourcesPayload);
  await write("monitor.json", monitorPayload);
  await write("defunct.json", defunctPayload);
  await write("tags.json", tagsPayload);
  await write("best.json", bestPayload);
  await write("stats.json", { apiVersion: "v1", ...stats });
  await write("search.json", sourcesPayload);
  await write("cms-candidates.json", {
    apiVersion: "v1",
    generatedAt,
    providers: onlineProviders,
  });
  await write("openapi.json", openapiPayload);
  await write(
    "index.json",
    {
      apiVersion: "v1",
      generatedAt,
      name: "拾萤资源组 API",
      documentation: "/api/",
      openapi: "/api/v1/openapi.json",
      endpoints: [
        "/api/v1/sources",
        "/api/v1/sources/{id}",
        "/api/v1/search?q=",
        "/api/v1/cms-candidates.json",
        "/api/v1/monitor",
        "/api/v1/best?mode=standard",
        "/api/v1/defunct",
        "/api/v1/tags",
        "/api/v1/stats",
        "/api/v1/status",
        "/api/v1/probe?ids=(最多20个)",
      ],
    }
  );

  for (const source of catalog) {
    const id = safeID(source.key);
    const payload = {
      apiVersion: "v1",
      generatedAt,
      source: {
        ...source,
        id: source.key,
      },
    };
    await write(path.join("source", `${id}.json`), payload);
  }
}

function safeID(value) {
  return String(value || "source")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function buildOpenAPI(generatedAt) {
  return {
    openapi: "3.0.3",
    info: {
      title: "拾萤资源组 API",
      version: "1.0.0",
      description: "拾萤自有采集站目录、监控状态、历史统计与最佳线路 API。",
    },
    servers: [{ url: "https://sources.yychuiyan.com" }],
    paths: {
      "/api/v1/sources": {
        get: {
          summary: "获取采集站列表",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            {
              name: "status",
              in: "query",
              schema: { type: "string", enum: ["online", "offline"] },
            },
            { name: "adult", in: "query", schema: { type: "boolean" } },
            { name: "tag", in: "query", schema: { type: "string" } },
            { name: "sort", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          ],
          responses: { 200: { description: "采集站分页列表" } },
        },
      },
      "/api/v1/sources/{id}": {
        get: {
          summary: "获取单个采集站详情",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { 200: { description: "采集站详情" }, 404: { description: "未找到" } },
        },
      },
      "/api/v1/search": {
        get: {
          summary: "搜索采集站",
          parameters: [
            {
              name: "q",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { 200: { description: "搜索结果" } },
        },
      },
      "/api/v1/cms-candidates.json": {
        get: {
          summary: "获取拾萤 App 可用的在线采集站",
          responses: { 200: { description: "在线候选池" } },
        },
      },
      "/api/v1/monitor": {
        get: { summary: "获取监控状态", responses: { 200: { description: "监控状态" } } },
      },
      "/api/v1/best": {
        get: {
          summary: "获取最佳活跃线路",
          parameters: [
            {
              name: "mode",
              in: "query",
              schema: { type: "string", enum: ["standard", "adult"] },
            },
          ],
          responses: { 200: { description: "最佳线路" } },
        },
      },
      "/api/v1/defunct": {
        get: { summary: "获取当前离线线路", responses: { 200: { description: "离线列表" } } },
      },
      "/api/v1/tags": {
        get: { summary: "获取标签统计", responses: { 200: { description: "标签列表" } } },
      },
      "/api/v1/stats": {
        get: { summary: "获取平台统计", responses: { 200: { description: "统计数据" } } },
      },
      "/api/v1/status": {
        get: {
          summary: "获取检测、发布、COS、API 与调度链路状态",
          responses: { 200: { description: "端到端运行状态" } },
        },
      },
      "/api/v1/probe": {
        get: {
          summary: "即时复测最多 20 个采集站的列表接口",
          parameters: [
            {
              name: "ids",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { 200: { description: "即时列表接口状态与响应时间" } },
        },
      },
    },
    "x-generated-at": generatedAt,
  };
}

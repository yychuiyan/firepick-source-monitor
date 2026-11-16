import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchMonitorWorkflow,
  handleAPIRequest,
  loadJSONData,
  querySources,
} from "./index.mjs";

const sources = [
  {
    id: "fast",
    name: "快速线路",
    api: "https://fast.example/api.php/provide/vod",
    status: "online",
    adult: false,
    score: 90,
    latencyMs: 200,
    tags: ["稳定"],
    history: { onlineCount: 9, offlineCount: 1 },
  },
  {
    id: "adult",
    name: "成人线路",
    api: "https://adult.example/api.php/provide/vod",
    status: "online",
    adult: true,
    score: 80,
    latencyMs: 100,
    tags: ["成人"],
    history: { onlineCount: 4, offlineCount: 1 },
  },
  {
    id: "down",
    name: "离线线路",
    api: "https://down.example/api.php/provide/vod",
    status: "offline",
    adult: false,
    score: 10,
    latencyMs: 0,
    tags: ["稳定"],
    error: "timeout",
    history: { onlineCount: 1, offlineCount: 9 },
  },
];

test("filters by status, adult mode and query with pagination", () => {
  const params = new URLSearchParams({
    q: "线路",
    status: "online",
    adult: "false",
    page: "1",
    limit: "1",
  });
  const result = querySources(sources, params);
  assert.equal(result.total, 1);
  assert.equal(result.sources[0].id, "fast");
  assert.equal(result.totalPages, 1);
});

test("sorts by latency and supports ascending order", () => {
  const result = querySources(
    sources,
    new URLSearchParams({ sort: "latency", order: "asc" })
  );
  assert.deepEqual(
    result.sources.map((item) => item.id),
    ["down", "adult", "fast"]
  );
});

test("serves single source details and standard best lines", async () => {
  const payloads = {
    "/api/v1/sources.json": { generatedAt: "now", sources },
    "/api/v1/best.json": {
      generatedAt: "now",
      sources: sources.map(({ id, adult }) => ({ id, adult })),
    },
  };
  const loadJSON = async (pathname) => payloads[pathname];

  const detail = await handleAPIRequest(
    new Request("https://api.example/api/v1/sources/fast"),
    { loadJSON }
  );
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).source.id, "fast");

  const best = await handleAPIRequest(
    new Request("https://api.example/api/v1/best?mode=standard"),
    { loadJSON }
  );
  assert.equal(best.status, 200);
  assert.deepEqual(
    (await best.json()).sources.map((item) => item.id),
    ["fast", "down"]
  );
});

test("dispatches the monitor workflow on the Worker cron", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 204 });
  };
  const ok = await dispatchMonitorWorkflow(fetchImpl, {
    WORKFLOW_DISPATCH_TOKEN: "token",
  });
  assert.equal(ok, true);
  assert.equal(
    captured.url,
    "https://api.github.com/repos/yychuiyan/firepick-source-monitor/actions/workflows/monitor.yml/dispatches"
  );
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer token");
  assert.deepEqual(JSON.parse(captured.init.body), { ref: "main" });
});

test("does not dispatch without a Worker token", async () => {
  let called = false;
  const ok = await dispatchMonitorWorkflow(
    async () => {
      called = true;
      return new Response(null, { status: 204 });
    },
    {}
  );
  assert.equal(ok, false);
  assert.equal(called, false);
});

test("verifies the protected dispatch health endpoint", async () => {
  let dispatched = 0;
  const request = (authorization) =>
    new Request("https://api.example/api/v1/health/dispatch", {
      method: "POST",
      headers: authorization ? { Authorization: authorization } : {},
    });

  const denied = await handleAPIRequest(request("Bearer wrong"), {
    dispatchToken: "secret",
  });
  assert.equal(denied.status, 401);

  const accepted = await handleAPIRequest(request("Bearer secret"), {
    dispatchToken: "secret",
    dispatchMonitor: async () => {
      dispatched += 1;
      return true;
    },
  });
  assert.equal(accepted.status, 202);
  assert.equal(dispatched, 1);
  assert.equal((await accepted.json()).ok, true);
});

test("loads the latest API snapshot from COS before the bundled asset", async () => {
  let requested;
  const payload = { generatedAt: "fresh", total: 3 };
  const result = await loadJSONData(
    new Request("https://sources.yychuiyan.com/api/v1/stats"),
    { API_DATA_ORIGIN: "https://cos.example/firepick-monitor/" },
    "/api/v1/stats.json",
    async (url) => {
      requested = url.href;
      return Response.json(payload);
    }
  );

  assert.equal(
    requested,
    "https://cos.example/firepick-monitor/api/v1/stats.json"
  );
  assert.deepEqual(result, payload);
});

test("falls back to bundled API data when COS is unavailable", async () => {
  const payload = { generatedAt: "bundled", total: 2 };
  const result = await loadJSONData(
    new Request("https://sources.yychuiyan.com/api/v1/stats"),
    {
      API_DATA_ORIGIN: "https://cos.example/firepick-monitor",
      ASSETS: {
        fetch: async () => Response.json(payload),
      },
    },
    "/api/v1/stats.json",
    async () => {
      throw new Error("network unavailable");
    }
  );

  assert.deepEqual(result, payload);
});

test("serves the system status endpoint", async () => {
  const payload = {
    apiVersion: "v1",
    overall: "healthy",
    checks: [{ id: "monitor", status: "success" }],
  };
  const response = await handleAPIRequest(
    new Request("https://sources.yychuiyan.com/api/v1/status"),
    {
      loadJSON: async () => {
        throw new Error("should not read a static JSON file");
      },
      loadStatus: async () => payload,
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
});

test("serves a realtime probe for requested source ids", async () => {
  let receivedIDs;
  const response = await handleAPIRequest(
    new Request(
      "https://sources.yychuiyan.com/api/v1/probe?ids=fast,down"
    ),
    {
      loadJSON: async () => ({ sources: [] }),
      loadProbe: async (ids) => {
        receivedIDs = ids;
        return {
          apiVersion: "v1",
          requested: ids.length,
          online: 1,
          offline: 1,
          results: ids.map((id) => ({ id })),
        };
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(receivedIDs, ["fast", "down"]);
  assert.equal((await response.json()).requested, 2);
});

test("rejects realtime probe requests without ids", async () => {
  const response = await handleAPIRequest(
    new Request("https://sources.yychuiyan.com/api/v1/probe"),
    { loadJSON: async () => ({ sources: [] }) }
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "missing_ids");
});

import assert from "node:assert/strict";
import test from "node:test";

import { handleAPIRequest, querySources } from "./index.mjs";

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

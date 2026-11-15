import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REALTIME_SOURCES,
  parseProbeIDs,
  probeRealtimeSources,
} from "./realtime-probe.mjs";

test("parses and caps realtime probe ids", () => {
  const ids = Array.from({ length: 25 }, (_, index) => `source-${index}`);
  const parsed = parseProbeIDs(` ${ids.join(", ")}, `);

  assert.equal(parsed.length, MAX_REALTIME_SOURCES);
  assert.equal(parsed[0], "source-0");
  assert.equal(parsed.at(-1), "source-19");
});

test("probes sources and reports reachable and failed lines", async () => {
  const now = new Date("2026-11-15T18:00:00.000Z");
  const result = await probeRealtimeSources(
    [
      { id: "fast", name: "快速线路", api: "https://fast.example/api.php/provide/vod" },
      { id: "down", name: "离线线路", api: "https://down.example/api.php/provide/vod" },
    ],
    {
      now: () => now,
      fetchImpl: async (url) => {
        if (String(url).startsWith("https://down.example")) {
          return new Response("busy", { status: 503 });
        }
        return Response.json({ code: 1, list: [{ vod_id: 1 }] });
      },
    }
  );

  assert.equal(result.checkedAt, now.toISOString());
  assert.equal(result.requested, 2);
  assert.equal(result.online, 1);
  assert.equal(result.offline, 1);
  assert.equal(result.results[0].id, "fast");
  assert.equal(result.results[0].status, "online");
  assert.equal(result.results[1].status, "offline");
  assert.equal(result.results[1].error, "HTTP 503");
});

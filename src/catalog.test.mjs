import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalog,
  canonicalHost,
  extractAPIEndpoints,
  mergeCandidates,
  normalizeAPI,
} from "./catalog.mjs";

test("extracts and normalizes AppleCMS endpoints from escaped config text", () => {
  const text = JSON.stringify({
    api: "https:\\/\\/Example.com\\/api.php\\/provide\\/vod\\/?ac=videolist",
    next: "https://other.example/inc/apijson.php",
    image: "https://cdn.example/poster.jpg",
  });
  assert.deepEqual(extractAPIEndpoints(text), [
    "https://example.com/api.php/provide/vod/",
    "https://other.example/inc/apijson.php",
  ]);
});

test("normalizes URL hosts and rejects non-API links", () => {
  assert.equal(canonicalHost("https://WWW.Example.com/path"), "www.example.com");
  assert.equal(canonicalHost("122.228.84.103:5822"), "122.228.84.103:5822");
  assert.equal(normalizeAPI("m3u8"), null);
  assert.equal(normalizeAPI("https://example.com/index.html"), null);
  assert.equal(
    normalizeAPI("https://example.com/api.php/provide/vod?ac=list&pg=1"),
    "https://example.com/api.php/provide/vod"
  );
});

test("merges seeds, previous catalog and discovered sources by host", () => {
  const merged = mergeCandidates({
    seeds: [
      { key: "seed", name: "Seed", api: "https://seed.example/api.php/provide/vod" },
    ],
    catalog: [
      {
        key: "known",
        name: "Known name",
        api: "https://seed.example/api.php/provide/vod",
        tags: ["known"],
      },
      {
        key: "known2",
        name: "Known 2",
        api: "https://known.example/api.php/provide/vod",
      },
    ],
    discovered: [
      { key: "new", name: "new.example", api: "https://new.example/provide/vod" },
      { key: "blocked", name: "blocked", api: "https://blocked.example/api.php" },
    ],
    excluded: ["blocked.example"],
  });
  assert.deepEqual(
    merged.map((item) => item.name),
    ["Seed", "Known 2", "new.example"]
  );
  assert.deepEqual(merged[0].tags, ["known"]);
});

test("builds persistent online and offline counters", () => {
  const now = "2026-11-15T00:00:00.000Z";
  const [entry] = buildCatalog(
    [
      {
        key: "a",
        name: "A",
        api: "https://a.example/api.php/provide/vod",
        online: true,
        score: 90,
        listMs: 100,
      },
    ],
    [
      {
        key: "a",
        api: "https://a.example/api.php/provide/vod",
        history: { onlineCount: 4, offlineCount: 1 },
        firstSeenAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    now
  );
  assert.equal(entry.history.onlineCount, 5);
  assert.equal(entry.history.offlineCount, 1);
  assert.equal(entry.firstSeenAt, "2026-11-01T00:00:00.000Z");
  assert.equal(entry.lastOnlineAt, now);
});

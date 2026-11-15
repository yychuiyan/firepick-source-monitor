import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalog,
  canonicalHost,
  extractAPIEndpoints,
  isDeadLink,
  mergeCandidates,
  normalizeAPI,
  selectCandidatesForProbe,
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

test("marks only repeatedly failing lines without a month of online checks as dead", () => {
  const now = "2026-11-15T00:00:00.000Z";
  const base = {
    status: "offline",
    history: { offlineCount: 8 },
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastOnlineAt: "2026-10-01T00:00:00.000Z",
  };

  assert.equal(isDeadLink(base, { now }), true);
  assert.equal(
    isDeadLink(
      { ...base, lastOnlineAt: "2026-10-20T00:00:00.000Z" },
      { now }
    ),
    false
  );
  assert.equal(
    isDeadLink(
      { ...base, history: { offlineCount: 2 } },
      { now }
    ),
    false
  );
  assert.equal(
    isDeadLink(
      { ...base, status: "online" },
      { now }
    ),
    false
  );
});

test("reserves probe slots for fresh candidates and skips dead lines", () => {
  const now = "2026-11-15T00:00:00.000Z";
  const catalog = [
    {
      key: "online",
      api: "https://online.example/api.php/provide/vod",
      status: "online",
    },
    {
      key: "recent",
      api: "https://recent.example/api.php/provide/vod",
      status: "offline",
      lastOnlineAt: "2026-11-10T00:00:00.000Z",
      history: { offlineCount: 4 },
    },
    {
      key: "dead",
      api: "https://dead.example/api.php/provide/vod",
      status: "offline",
      lastOnlineAt: "2026-09-01T00:00:00.000Z",
      history: { offlineCount: 20 },
    },
  ];
  const fresh = Array.from({ length: 5 }, (_, index) => ({
    key: `fresh-${index}`,
    api: `https://fresh-${index}.example/api.php/provide/vod`,
    discoverySource: "internet",
  }));
  const merged = [
    {
      key: "seed",
      api: "https://seed.example/api.php/provide/vod",
      discoverySource: "seed",
    },
    ...catalog,
    ...fresh,
  ];

  const selection = selectCandidatesForProbe({
    merged,
    catalog,
    now,
    limit: 6,
    freshReserve: 3,
  });
  const keys = selection.items.map((item) => item.key);

  assert.deepEqual(keys.slice(0, 2), ["seed", "online"]);
  assert.equal(keys.filter((key) => key.startsWith("fresh-")).length, 3);
  assert.ok(keys.includes("recent"));
  assert.ok(!keys.includes("dead"));
  assert.deepEqual(selection.stats, {
    limit: 6,
    freshReserve: 3,
    merged: 9,
    selected: 6,
    fixed: 1,
    online: 1,
    freshAvailable: 5,
    freshSelected: 3,
    recentOffline: 1,
    deadSkipped: 1,
  });
});

test("uses spare capacity for additional fresh candidates", () => {
  const fresh = Array.from({ length: 4 }, (_, index) => ({
    key: `fresh-${index}`,
    api: `https://fresh-${index}.example/api.php/provide/vod`,
  }));
  const selection = selectCandidatesForProbe({
    merged: fresh,
    catalog: [],
    limit: 4,
    freshReserve: 2,
  });

  assert.equal(selection.items.length, 4);
  assert.equal(selection.stats.freshSelected, 4);
});

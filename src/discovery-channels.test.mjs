import assert from "node:assert/strict";
import test from "node:test";

import { discoverAlternativeChannels } from "./discovery-channels.mjs";

function emptyChannels() {
  return {
    maxCandidates: 20,
    github: { enabled: false },
    gitlab: { enabled: false },
    gitee: { enabled: false },
    codeberg: { enabled: false },
    searchApi: { enabled: false },
    sitemaps: { enabled: false },
    commonCrawl: { enabled: false },
    directoryUrls: [],
  };
}

test("discovers API candidates from a public sitemap and its pages", async () => {
  const fetchImpl = async (value) => {
    const url = String(value);
    if (url.includes("sitemap.xml")) {
      return new Response(
        "<urlset><url><loc>https://catalog.example/page</loc></url></urlset>",
        { status: 200 }
      );
    }
    return new Response(
      '{"api":"https://vod.example/api.php/provide/vod"}',
      { status: 200 }
    );
  };
  const rows = await discoverAlternativeChannels(
    {
      ...emptyChannels(),
      sitemaps: {
        enabled: true,
        urls: ["https://catalog.example/sitemap.xml"],
        maxSitemaps: 2,
        maxPages: 2,
      },
    },
    { fetchImpl }
  );
  assert.deepEqual(
    rows.map((row) => row.api),
    ["https://vod.example/api.php/provide/vod"]
  );
  assert.equal(rows[0].discoverySource, "sitemap");
});

test("discovers endpoints from a configured SearXNG search API", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            title: "TVBox config",
            url: "https://config.example/list",
            content: "https://search.example/inc/apijson.php",
          },
        ],
      }),
      { status: 200 }
    );
  const rows = await discoverAlternativeChannels(
    {
      ...emptyChannels(),
      searchApi: {
        enabled: true,
        searxngURL: "https://search.example",
        queries: ["tvbox"],
        fetchResultPages: false,
      },
    },
    { fetchImpl }
  );
  assert.deepEqual(
    rows.map((row) => row.api),
    ["https://search.example/inc/apijson.php"]
  );
  assert.equal(rows[0].discoverySource, "searxng");
});

test("generates bounded candidate paths from certificate transparency hosts", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify([
        {
          name_value: "*.tvbox-api.example.tvbox-api.example.example",
        },
      ]),
      { status: 200 }
    );
  const rows = await discoverAlternativeChannels(
    {
      ...emptyChannels(),
      certificateTransparency: {
        enabled: true,
        queries: ["tvbox"],
        maxDomains: 2,
        maxPathsPerDomain: 1,
        paths: ["/api.php/provide/vod"],
      },
    },
    { fetchImpl }
  );
  assert.deepEqual(
    rows.map((row) => row.api),
    [
      "https://tvbox-api.example.tvbox-api.example.example/api.php/provide/vod",
    ]
  );
  assert.equal(rows[0].discoverySource, "certificate");
});

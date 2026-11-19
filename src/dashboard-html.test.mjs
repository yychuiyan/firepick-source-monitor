import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DASHBOARD_URL = new URL("../public/index.html", import.meta.url);
const PAGE_ROUTES = ["lines", "insights", "status", "method"];

test("page routes do not collide with native DOM anchor targets", async () => {
  const html = await readFile(DASHBOARD_URL, "utf8");
  const ids = new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  );

  assert.deepEqual(
    PAGE_ROUTES.filter((route) => ids.has(route)),
    []
  );
});

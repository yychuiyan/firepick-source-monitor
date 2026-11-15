#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "public", "data", "catalog.json");
const exclusionsPath = path.join(root, "exclusions.json");
const apply = process.argv.includes("--apply");
const keepErrors = [/^search miss$/i, /timeout|aborted/i, /HTTP 429/i];

const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
const exclusionFile = JSON.parse(await fs.readFile(exclusionsPath, "utf8"));
const existing = Array.isArray(exclusionFile.excluded)
  ? exclusionFile.excluded
  : [];
const existingHosts = new Set(existing.map((entry) => String(entry.host).toLowerCase()));
const additions = [];

for (const source of catalog.providers || []) {
  if (source.status !== "offline") continue;
  const error = String(source.error || "unknown");
  if (keepErrors.some((pattern) => pattern.test(error))) continue;
  const offlineChecks = Number(source.history?.offlineCount || 0);
  if (offlineChecks < 3) continue;
  let host;
  try {
    host = new URL(source.api).host.toLowerCase();
  } catch {
    continue;
  }
  if (!host || existingHosts.has(host)) continue;
  existingHosts.add(host);
  additions.push({
    name: source.name,
    host,
    reason: `连续 ${offlineChecks} 次检测失败：${error}`,
  });
}

if (!apply) {
  console.log(`Would add ${additions.length} confirmed-dead hosts:`);
  for (const entry of additions) {
    console.log(`${entry.host}\t${entry.reason}`);
  }
  process.exit(0);
}

await fs.writeFile(
  exclusionsPath,
  `${JSON.stringify(
    {
      ...exclusionFile,
      meta: {
        ...exclusionFile.meta,
        updatedAt: new Date().toISOString().slice(0, 10),
      },
      excluded: [...existing, ...additions],
    },
    null,
    2
  )}\n`
);
console.log(`Added ${additions.length} confirmed-dead hosts to exclusions.json`);

#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public", "api", "v1", "cms-candidates.json");
const targets = [
  path.resolve(
    root,
    "../firepick/Packages/FirepickKit/Sources/FirepickProvider/Resources/cms-candidates.json"
  ),
  path.resolve(root, "../firepick/sources/cms-candidates.json"),
];

const payload = JSON.parse(await fs.readFile(source, "utf8"));
const providers = Array.isArray(payload.providers) ? payload.providers : [];
if (!providers.length) {
  throw new Error("monitor cms-candidates.json has no online providers");
}
const output = `${JSON.stringify(
  {
    generatedAt: payload.generatedAt,
    providers,
  },
  null,
  2
)}\n`;

for (const target of targets) {
  await fs.writeFile(target, output);
  console.log(`Synced ${providers.length} providers to ${target}`);
}

export const MAX_REALTIME_SOURCES = 20;

export function parseProbeIDs(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_REALTIME_SOURCES);
}

export async function probeRealtimeSources(
  sources,
  {
    fetchImpl = fetch,
    timeoutMs = 6000,
    concurrency = 6,
    now = () => new Date(),
  } = {}
) {
  const checkedAt = now().toISOString();
  const items = await mapLimit(sources, concurrency, (source) =>
    probeSource(source, { fetchImpl, timeoutMs, checkedAt })
  );
  return {
    apiVersion: "v1",
    checkedAt,
    requested: items.length,
    online: items.filter((item) => item.status === "online").length,
    offline: items.filter((item) => item.status === "offline").length,
    results: items,
  };
}

async function probeSource(source, { fetchImpl, timeoutMs, checkedAt }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(source.api);
    url.searchParams.set("ac", "videolist");
    url.searchParams.set("pg", "1");
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json,text/plain,text/html,*/*",
        "User-Agent": "okhttp/4.1.0",
      },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const preview = await readPreview(response);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (/^<!doctype\s+html|^<html/i.test(preview)) {
      throw new Error("返回 HTML 页面");
    }
    return {
      id: source.id,
      name: source.name,
      status: "online",
      latencyMs: Date.now() - startedAt,
      checkedAt,
      error: null,
    };
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "请求超时"
        : String(error?.message || error);
    return {
      id: source.id,
      name: source.name,
      status: "offline",
      latencyMs: Date.now() - startedAt,
      checkedAt,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readPreview(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  try {
    const chunk = await reader.read();
    return chunk.value
      ? new TextDecoder().decode(chunk.value.slice(0, 512)).trim()
      : "";
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker)
  );
  return results;
}

import {
  candidateKey,
  canonicalHost,
  extractAPIEndpoints,
} from "./catalog.mjs";

const configFilePattern = /\.(?:json|txt|ya?ml)$/i;
const ignoredPathPattern =
  /(?:^|\/)(?:node_modules|\.git|live|m3u|iptv|image|screenshot|backup)(?:\/|$)/i;
const userAgent = "Firepick-Source-Discovery/1.0";

export async function discoverAlternativeChannels(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const env = options.env || process.env;
  const limit = Number(config.maxCandidates || 120);
  const channels = await Promise.all([
    discoverGitLab(config.gitlab || {}, fetchImpl).catch(() => []),
    discoverGitee(config.gitee || {}, fetchImpl, env.GITEE_TOKEN).catch(() => []),
    discoverCodeberg(config.codeberg || {}, fetchImpl, env.CODEBERG_TOKEN).catch(
      () => []
    ),
    discoverSearchAPIs(config.searchApi || {}, fetchImpl, env).catch(() => []),
    discoverSitemaps(config.sitemaps || {}, fetchImpl).catch(() => []),
    discoverCommonCrawl(config.commonCrawl || {}, fetchImpl).catch(() => []),
    discoverCertificateTransparency(config.certificateTransparency || {}, fetchImpl).catch(
      () => []
    ),
    discoverGenericDirectories(config.directoryUrls || [], fetchImpl).catch(() => []),
  ]);
  return dedupe(channels.flat()).slice(0, limit);
}

async function discoverGitLab(config, fetchImpl) {
  if (config.enabled === false) return [];
  const repositories = [];
  for (const query of config.searchQueries || ["tvbox"]) {
    const url = new URL("https://gitlab.com/api/v4/projects");
    url.searchParams.set("search", query);
    url.searchParams.set("order_by", "last_activity_at");
    url.searchParams.set("sort", "desc");
    url.searchParams.set("per_page", String(Number(config.maxRepositories || 4)));
    url.searchParams.set("simple", "true");
    const rows = await fetchJSON(url, fetchImpl);
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row?.id && row?.path_with_namespace) {
        repositories.push({
          id: row.id,
          fullName: row.path_with_namespace,
          branch: row.default_branch || "main",
        });
      }
    }
  }
  const results = [];
  for (const repository of uniqueRepositories(repositories).slice(
    0,
    Number(config.maxRepositories || 4)
  )) {
    const treeURL = new URL(
      `https://gitlab.com/api/v4/projects/${repository.id}/repository/tree`
    );
    treeURL.searchParams.set("recursive", "true");
    treeURL.searchParams.set("per_page", "100");
    const tree = await fetchJSON(treeURL, fetchImpl);
    const files = selectConfigFiles(tree, Number(config.maxFilesPerRepository || 3));
    for (const file of files) {
      const path = encodePath(file.path);
      results.push(
        ...(await discoverURL(
          `https://gitlab.com/${repository.fullName}/-/raw/${encodeURIComponent(
            repository.branch
          )}/${path}`,
          fetchImpl,
          "gitlab",
          `${repository.fullName}/${file.path}`
        ))
      );
    }
  }
  return results;
}

async function discoverGitee(config, fetchImpl, token) {
  if (config.enabled === false) return [];
  const headers = token ? { Authorization: `token ${token}` } : {};
  const repositories = [];
  for (const query of config.searchQueries || ["tvbox"]) {
    const url = new URL("https://gitee.com/api/v5/search/repositories");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(Number(config.maxRepositories || 4)));
    const rows = await fetchJSON(url, fetchImpl, headers);
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row?.full_name) {
        repositories.push({
          fullName: row.full_name,
          branch: row.default_branch || "master",
        });
      }
    }
  }
  const results = [];
  for (const repository of uniqueRepositories(repositories).slice(
    0,
    Number(config.maxRepositories || 4)
  )) {
    const treeURL = new URL(
      `https://gitee.com/api/v5/repos/${repository.fullName}/git/trees/${encodeURIComponent(
        repository.branch
      )}`
    );
    treeURL.searchParams.set("recursive", "1");
    const tree = await fetchJSON(treeURL, fetchImpl, headers);
    const files = selectConfigFiles(tree?.tree, Number(config.maxFilesPerRepository || 3));
    for (const file of files) {
      results.push(
        ...(await discoverURL(
          `https://gitee.com/${repository.fullName}/raw/${encodeURIComponent(
            repository.branch
          )}/${encodePath(file.path)}`,
          fetchImpl,
          "gitee",
          `${repository.fullName}/${file.path}`
        ))
      );
    }
  }
  return results;
}

async function discoverCodeberg(config, fetchImpl, token) {
  if (config.enabled === false) return [];
  const headers = token ? { Authorization: `token ${token}` } : {};
  const repositories = [];
  for (const query of config.searchQueries || ["tvbox"]) {
    const url = new URL("https://codeberg.org/api/v1/repos/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(Number(config.maxRepositories || 4)));
    const data = await fetchJSON(url, fetchImpl, headers);
    for (const row of Array.isArray(data?.data) ? data.data : []) {
      if (row?.full_name) {
        repositories.push({
          fullName: row.full_name,
          branch: row.default_branch || "main",
        });
      }
    }
  }
  const results = [];
  for (const repository of uniqueRepositories(repositories).slice(
    0,
    Number(config.maxRepositories || 4)
  )) {
    const treeURL = new URL(
      `https://codeberg.org/api/v1/repos/${repository.fullName}/git/trees/${encodeURIComponent(
        repository.branch
      )}`
    );
    treeURL.searchParams.set("recursive", "true");
    treeURL.searchParams.set("per_page", "100");
    const tree = await fetchJSON(treeURL, fetchImpl, headers);
    const files = selectConfigFiles(tree?.tree, Number(config.maxFilesPerRepository || 3));
    for (const file of files) {
      results.push(
        ...(await discoverURL(
          `https://codeberg.org/${repository.fullName}/raw/branch/${encodeURIComponent(
            repository.branch
          )}/${encodePath(file.path)}`,
          fetchImpl,
          "codeberg",
          `${repository.fullName}/${file.path}`
        ))
      );
    }
  }
  return results;
}

async function discoverSearchAPIs(config, fetchImpl, env) {
  if (config.enabled === false) return [];
  const queries = config.queries || [];
  const resultLimit = Number(config.maxResultsPerQuery || 6);
  const fetchResultPages = config.fetchResultPages !== false;
  const searchResults = [];

  for (const query of queries) {
    if (env.BRAVE_SEARCH_API_KEY) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(resultLimit));
      const data = await fetchJSON(url, fetchImpl, {
        Accept: "application/json",
        "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY,
      });
      searchResults.push(...normalizeSearchRows(data?.web?.results, "brave"));
    }
    if (env.BING_SEARCH_API_KEY) {
      const url = new URL("https://api.bing.microsoft.com/v7.0/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(resultLimit));
      url.searchParams.set("mkt", "zh-CN");
      const data = await fetchJSON(url, fetchImpl, {
        "Ocp-Apim-Subscription-Key": env.BING_SEARCH_API_KEY,
      });
      searchResults.push(...normalizeSearchRows(data?.webPages?.value, "bing"));
    }
    if (env.SERPER_API_KEY) {
      const data = await fetchJSON(
        "https://google.serper.dev/search",
        fetchImpl,
        { "X-API-KEY": env.SERPER_API_KEY },
        { method: "POST", body: JSON.stringify({ q: query, num: resultLimit }) }
      );
      searchResults.push(...normalizeSearchRows(data?.organic, "serper"));
    }
    if (env.GOOGLE_CUSTOM_SEARCH_API_KEY && env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID) {
      const url = new URL("https://www.googleapis.com/customsearch/v1");
      url.searchParams.set("key", env.GOOGLE_CUSTOM_SEARCH_API_KEY);
      url.searchParams.set("cx", env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID);
      url.searchParams.set("q", query);
      url.searchParams.set("num", String(Math.min(10, resultLimit)));
      const data = await fetchJSON(url, fetchImpl);
      searchResults.push(...normalizeSearchRows(data?.items, "google"));
    }
    if (env.TAVILY_API_KEY) {
      const data = await fetchJSON("https://api.tavily.com/search", fetchImpl, {
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
      }, {
        method: "POST",
        body: JSON.stringify({
          query,
          max_results: resultLimit,
          search_depth: "basic",
        }),
      });
      searchResults.push(...normalizeSearchRows(data?.results, "tavily"));
    }
    if (config.searxngURL) {
      const url = new URL("/search", config.searxngURL);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const data = await fetchJSON(url, fetchImpl);
      searchResults.push(...normalizeSearchRows(data?.results, "searxng"));
    }
  }

  const selected = dedupeSearchResults(searchResults).slice(
    0,
    Number(config.maxResults || 40)
  );
  const outputs = await mapLimit(selected, 6, async (row) => {
    const candidates = candidatesFromText(
      `${row.title}\n${row.description}\n${row.url}`,
      row.provider,
      row.url
    );
    if (fetchResultPages) {
      candidates.push(
        ...(await discoverURL(row.url, fetchImpl, row.provider, row.url))
      );
    }
    return candidates;
  });
  return outputs.flat();
}

async function discoverSitemaps(config, fetchImpl) {
  if (config.enabled === false) return [];
  const pending = [...(config.urls || [])];
  const fetched = new Set();
  const pages = [];
  while (pending.length && fetched.size < Number(config.maxSitemaps || 8)) {
    const url = pending.shift();
    if (!url || fetched.has(url)) continue;
    fetched.add(url);
    const text = await fetchText(url, fetchImpl);
    if (!text) continue;
    const locations = extractLocations(text);
    for (const location of locations) {
      if (/\.xml(?:$|\?)/i.test(location) && fetched.size < Number(config.maxSitemaps || 8)) {
        pending.push(location);
      } else {
        pages.push(location);
      }
    }
  }
  const outputs = await mapLimit(
    pages.slice(0, Number(config.maxPages || 20)),
    6,
    (page) => discoverURL(page, fetchImpl, "sitemap", page)
  );
  return outputs.flat();
}

async function discoverCommonCrawl(config, fetchImpl) {
  if (config.enabled === false) return [];
  const collections = await fetchJSON(
    "https://index.commoncrawl.org/collinfo.json",
    fetchImpl
  );
  const indexURL = config.indexURL || collections?.[0]?.["cdx-api"];
  if (!indexURL) return [];
  const outputs = [];
  for (const pattern of (config.patterns || []).slice(0, Number(config.maxPatterns || 4))) {
    const url = new URL(indexURL);
    url.searchParams.set("url", pattern);
    url.searchParams.set("output", "json");
    url.searchParams.set("filter", "status:200");
    url.searchParams.set("collapse", "urlkey");
    url.searchParams.set("fl", "url");
    const text = await fetchText(url, fetchImpl, 25000);
    if (!text || text.trim().startsWith("{")) continue;
    const urls = text
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line).url;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(0, Number(config.maxResultsPerPattern || 20));
    outputs.push(...candidatesFromText(urls.join("\n"), "commoncrawl", indexURL));
  }
  return outputs;
}

async function discoverCertificateTransparency(config, fetchImpl) {
  if (config.enabled === false) return [];
  const hosts = new Set();
  for (const query of config.queries || ["tvbox"]) {
    const url = new URL("https://crt.sh/");
    url.searchParams.set("q", `%${query}%`);
    url.searchParams.set("output", "json");
    url.searchParams.set("exclude", "expired");
    const rows = await fetchJSON(url, fetchImpl);
    for (const row of Array.isArray(rows) ? rows : []) {
      for (const raw of String(row.name_value || "").split(/\s+/)) {
        const host = raw.replace(/^\*\./, "").trim().toLowerCase();
        if (host.includes(".") && !host.includes(" ")) hosts.add(host);
      }
      if (hosts.size >= Number(config.maxDomains || 20)) break;
    }
  }
  const paths = config.paths || ["/api.php/provide/vod", "/provide/vod"];
  const outputs = [];
  for (const host of [...hosts].slice(0, Number(config.maxDomains || 20))) {
    for (const path of paths.slice(0, Number(config.maxPathsPerDomain || 2))) {
      outputs.push(...candidatesFromText(`https://${host}${path}`, "certificate", host));
    }
  }
  return outputs;
}

async function discoverGenericDirectories(urls, fetchImpl) {
  const outputs = [];
  for (const url of urls) {
    outputs.push(...(await discoverURL(url, fetchImpl, "directory", url)));
  }
  return outputs;
}

async function discoverURL(url, fetchImpl, source, sourceURL = url) {
  const text = await fetchText(url, fetchImpl);
  return text ? candidatesFromText(text, source, sourceURL) : [];
}

function candidatesFromText(text, source, sourceURL) {
  return extractAPIEndpoints(text).map((api) => {
    const host = canonicalHost(api);
    return {
      key: candidateKey(host),
      name: host,
      api,
      discoverySource: source,
      metadata: { sourceURL },
    };
  });
}

function selectConfigFiles(files, limit) {
  return (Array.isArray(files) ? files : [])
    .filter(
      (item) =>
        item?.type === "blob" &&
        configFilePattern.test(item.path || "") &&
        !ignoredPathPattern.test(item.path || "")
    )
    .sort((a, b) => scoreConfigPath(b.path) - scoreConfigPath(a.path))
    .slice(0, limit);
}

function scoreConfigPath(value) {
  const path = String(value || "").toLowerCase();
  let score = 0;
  if (/config|vod|api|source|repo|line/.test(path)) score += 20;
  if (/\.json$/.test(path)) score += 10;
  if (/readme|workflow|package|lock/.test(path)) score -= 30;
  return score;
}

function normalizeSearchRows(rows, provider) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      provider,
      title: String(row?.title || row?.name || ""),
      url: String(row?.url || row?.link || row?.href || ""),
      description: String(row?.description || row?.snippet || row?.content || ""),
    }))
    .filter((row) => /^https?:\/\//i.test(row.url));
}

function dedupeSearchResults(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });
}

function uniqueRepositories(repositories) {
  const seen = new Set();
  return repositories.filter((repository) => {
    if (seen.has(repository.fullName)) return false;
    seen.add(repository.fullName);
    return true;
  });
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const host = canonicalHost(item.api);
    if (!host || seen.has(host)) return false;
    seen.add(host);
    return true;
  });
}

function extractLocations(text) {
  return [...String(text).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeXML(match[1]))
    .filter((url) => /^https?:\/\//i.test(url));
}

function decodeXML(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchText(url, fetchImpl, timeout = 12000) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json,text/plain,text/html,*/*", "User-Agent": userAgent },
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function fetchJSON(url, fetchImpl, headers = {}, init = {}) {
  try {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent,
        ...headers,
      },
      signal: AbortSignal.timeout(15000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
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
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

function encodePath(path) {
  return String(path || "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

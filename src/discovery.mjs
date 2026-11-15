import {
  candidateKey,
  canonicalHost,
  extractAPIEndpoints,
  normalizeAPI,
} from "./catalog.mjs";
import { discoverAlternativeChannels } from "./discovery-channels.mjs";

const githubAPI = "https://api.github.com";
const discoveryFilePattern = /\.(?:json|txt|ya?ml)$/i;
const ignoredPathPattern =
  /(?:^|\/)(?:node_modules|\.git|live|m3u|iptv|image|screenshot|backup)(?:\/|$)/i;

export async function discoverInternetSources(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const token = options.githubToken || process.env.GITHUB_TOKEN || "";
  const maxCandidates = Number(config.maxCandidates || 160);
  const githubLimit = Math.min(
    maxCandidates,
    Number(config.github?.maxCandidates || 100)
  );
  const outputs = [];

  for (const url of config.feedUrls || []) {
    outputs.push(...(await discoverURL(url, fetchImpl, "feed")));
  }

  const github = config.github || {};
  if (github.enabled !== false) {
    const repositories = new Set();
    for (const query of github.searchQueries || []) {
      const found = await searchGitHubRepositories(
        query,
        Number(github.maxRepositories || 6),
        fetchImpl,
        token
      );
      for (const repository of found) repositories.add(repository);
    }
    for (const repository of github.repositories || []) {
      repositories.add(repository);
    }

    if (token) {
      for (const query of github.codeQueries || []) {
        const files = await searchGitHubCode(
          query,
          Number(github.maxCodeFiles || 8),
          fetchImpl,
          token
        );
        for (const file of files) {
          outputs.push(
            ...(await discoverURL(
              file.rawURL,
              fetchImpl,
              "github-code",
              `${file.repository}/${file.path}`
            ))
          );
          if (outputs.length >= githubLimit) break;
        }
        if (outputs.length >= githubLimit) break;
      }
    }

    for (const repository of [...repositories].slice(
      0,
      Number(github.maxRepositories || 6)
    )) {
      outputs.push(
        ...(await discoverGitHubRepository(
          repository,
          Number(github.maxFilesPerRepository || 4),
          fetchImpl,
          token
        ))
      );
      if (outputs.length >= githubLimit) break;
    }
  }

  const alternatives = await discoverAlternativeChannels(
    {
      ...config,
      maxCandidates: Math.max(0, maxCandidates - outputs.length),
    },
    { ...options, fetchImpl }
  );
  outputs.push(...alternatives);

  const seen = new Set();
  return outputs
    .filter((item) => {
      const host = canonicalHost(item.api);
      if (!host || seen.has(host)) return false;
      seen.add(host);
      return true;
    })
    .slice(0, maxCandidates);
}

async function searchGitHubCode(query, limit, fetchImpl, token) {
  const url = new URL(`${githubAPI}/search/code`);
  url.searchParams.set("q", `${query} in:file`);
  url.searchParams.set("per_page", String(limit));
  const data = await fetchJSON(url, fetchImpl, token);
  return (Array.isArray(data?.items) ? data.items : [])
    .map((item) => {
      const repository = String(item?.repository?.full_name || "");
      const branch = String(
        item?.repository?.default_branch || item?.repository?.defaultBranch || "main"
      );
      const path = String(item?.path || "")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      if (!repository || !path) return null;
      return {
        repository,
        path: decodeURIComponent(path),
        rawURL: `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(
          branch
        )}/${path}`,
      };
    })
    .filter(Boolean);
}

async function searchGitHubRepositories(query, limit, fetchImpl, token) {
  const url = new URL(`${githubAPI}/search/repositories`);
  url.searchParams.set("q", `${query} pushed:>2025-01-01`);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(limit));
  const data = await fetchJSON(url, fetchImpl, token);
  return (Array.isArray(data?.items) ? data.items : [])
    .map((item) => String(item.full_name || ""))
    .filter(Boolean);
}

async function discoverGitHubRepository(repository, maxFiles, fetchImpl, token) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) return [];
  const metadata = await fetchJSON(
    new URL(`${githubAPI}/repos/${repository}`),
    fetchImpl,
    token
  );
  const branch = metadata?.default_branch || "main";
  const tree = await fetchJSON(
    new URL(
      `${githubAPI}/repos/${repository}/git/trees/${encodeURIComponent(
        branch
      )}?recursive=1`
    ),
    fetchImpl,
    token
  );
  const files = (Array.isArray(tree?.tree) ? tree.tree : [])
    .filter(
      (item) =>
        item.type === "blob" &&
        discoveryFilePattern.test(item.path || "") &&
        !ignoredPathPattern.test(item.path || "") &&
        Number(item.size || 0) > 0 &&
        Number(item.size || 0) <= 750_000
    )
    .sort((a, b) => scoreConfigPath(b.path) - scoreConfigPath(a.path))
    .slice(0, maxFiles);

  const results = [];
  for (const file of files) {
    const path = String(file.path || "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const rawURL = `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(
      branch
    )}/${path}`;
    results.push(
      ...(await discoverURL(
        rawURL,
        fetchImpl,
        "github",
        `${repository}/${file.path}`
      ))
    );
  }
  return results;
}

function scoreConfigPath(value) {
  const path = String(value || "").toLowerCase();
  let score = 0;
  if (/config|vod|api|source|repo|line/.test(path)) score += 20;
  if (/\.json$/.test(path)) score += 10;
  if (/readme|workflow|package|lock/.test(path)) score -= 30;
  return score;
}

async function discoverURL(url, fetchImpl, source, sourceURL = url) {
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json,text/plain,text/html,*/*",
        "User-Agent": "Firepick-Source-Discovery/1.0",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return [];
    const text = await response.text();
    return extractAPIEndpoints(text).map((api) => ({
      key: candidateKey(canonicalHost(api)),
      name: canonicalHost(api),
      api,
      discoverySource: source,
      metadata: { sourceURL },
    }));
  } catch {
    return [];
  }
}

async function fetchJSON(url, fetchImpl, token) {
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Firepick-Source-Discovery/1.0",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export { normalizeAPI };

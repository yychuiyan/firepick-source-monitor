const DEFAULT_DATA_ORIGIN =
  "https://firepick-1302621537.cos.ap-shanghai.myqcloud.com/firepick-monitor";
const DEFAULT_PUBLIC_ORIGIN = "https://sources.yychuiyan.com";
const DEFAULT_REPOSITORY = "yychuiyan/firepick-source-monitor";

const WORKFLOWS = [
  { id: "monitor", name: "线路检测与发布", workflow: "monitor.yml" },
  { id: "worker", name: "Worker 部署", workflow: "deploy-worker.yml" },
  { id: "watchdog", name: "定时守护", workflow: "monitor-watchdog.yml" },
];

export async function buildSystemStatus(
  { env = {}, fetchImpl = fetch, now = () => new Date() } = {}
) {
  const checkedAt = now();
  const dataOrigin = String(env.API_DATA_ORIGIN || DEFAULT_DATA_ORIGIN).replace(
    /\/+$/,
    ""
  );
  const publicOrigin = String(
    env.PUBLIC_SITE_ORIGIN || DEFAULT_PUBLIC_ORIGIN
  ).replace(/\/+$/, "");
  const cacheBust = checkedAt.getTime();

  const [
    monitorWorkflow,
    workerWorkflow,
    watchdogWorkflow,
    pages,
    cosData,
    cosAPI,
  ] =
    await Promise.all([
      fetchWorkflowStatus(WORKFLOWS[0], env, fetchImpl),
      fetchWorkflowStatus(WORKFLOWS[1], env, fetchImpl),
      fetchWorkflowStatus(WORKFLOWS[2], env, fetchImpl),
      probeJSON(
        "页面数据",
        `${publicOrigin}/data/stats.json?health=${cacheBust}`,
        fetchImpl
      ),
      probeJSON(
        "COS 数据",
        `${dataOrigin}/data/stats.json?health=${cacheBust}`,
        fetchImpl
      ),
      probeJSON(
        "COS API",
        `${dataOrigin}/api/v1/stats.json?health=${cacheBust}`,
        fetchImpl
      ),
    ]);

  const monitorCheck = workflowCheck(
    monitorWorkflow,
    "线路检测",
    "最近一次检测工作流"
  );
  const pagesCheck = probeCheck(
    pages,
    "页面发布",
    "sources.yychuiyan.com/data/stats.json"
  );
  const cosCheck = combineCOSChecks(cosData, cosAPI);
  const apiStatus =
    workerWorkflow.status === "failure" ? "warning" : "success";
  const apiCheck = {
    id: "api",
    title: "自有 API",
    status: apiStatus,
    detail:
      workerWorkflow.status === "failure"
        ? "状态接口可访问，但最近一次 Worker 部署失败"
        : "Worker 状态接口已在当前请求中正常响应",
    latencyMs: null,
    checkedAt: checkedAt.toISOString(),
    href: workerWorkflow.url,
  };

  const validSnapshots = [pages, cosData, cosAPI].filter(
    (item) => item.status === "success" && item.generatedAt
  );
  const newestSnapshot = validSnapshots
    .map((item) => new Date(item.generatedAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const snapshotAgeSeconds = newestSnapshot
    ? Math.max(0, Math.round((checkedAt.getTime() - newestSnapshot) / 1000))
    : null;
  const freshnessStatus =
    snapshotAgeSeconds == null
      ? "failure"
      : snapshotAgeSeconds <= 25 * 60
        ? "success"
        : snapshotAgeSeconds <= 45 * 60
          ? "warning"
          : "failure";
  const freshnessCheck = {
    id: "freshness",
    title: "数据新鲜度",
    status: freshnessStatus,
    detail:
      snapshotAgeSeconds == null
        ? "没有读到可用的数据时间戳"
        : `最新快照生成于 ${formatAge(snapshotAgeSeconds)}前`,
    latencyMs: null,
    checkedAt: checkedAt.toISOString(),
  };

  const snapshots = [
    snapshotFromProbe("pages", "页面快照", pages),
    snapshotFromProbe("cos-data", "COS 数据", cosData),
    snapshotFromProbe("cos-api", "COS API", cosAPI),
  ];
  const checks = [
    monitorCheck,
    pagesCheck,
    cosCheck,
    apiCheck,
    freshnessCheck,
  ];
  const attention = checks.filter((item) => item.status !== "success");
  const failures = checks.filter((item) => item.status === "failure");
  const overall = failures.length
    ? "failed"
    : attention.length
      ? "degraded"
      : "healthy";
  const generatedTimes = [
    ...new Set(
      validSnapshots.map((item) => new Date(item.generatedAt).toISOString())
    ),
  ];
  const consistency = {
    status:
      generatedTimes.length === 1
        ? "success"
        : generatedTimes.length > 1
          ? "warning"
          : "failure",
    detail:
      generatedTimes.length === 1
        ? "页面、COS 数据与 COS API 时间戳一致"
        : generatedTimes.length > 1
          ? "三个数据入口不是同一份快照"
          : "无法完成快照一致性检查",
  };

  return {
    apiVersion: "v1",
    checkedAt: checkedAt.toISOString(),
    overall,
    summary: summaryFor(overall, attention),
    snapshotAt: generatedTimes.length ? generatedTimes.sort().at(-1) : null,
    freshness: {
      status: freshnessStatus,
      ageSeconds: snapshotAgeSeconds,
    },
    consistency,
    checks,
    snapshots,
    workflows: [monitorWorkflow, workerWorkflow, watchdogWorkflow],
  };
}

async function fetchWorkflowStatus(definition, env, fetchImpl) {
  const token = String(env.WORKFLOW_DISPATCH_TOKEN || "").trim();
  const repository = String(
    env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY
  ).trim();
  const base = {
    id: definition.id,
    name: definition.name,
    workflow: definition.workflow,
    status: "unknown",
    conclusion: null,
    event: null,
    runId: null,
    runNumber: null,
    createdAt: null,
    updatedAt: null,
    durationMs: null,
    url: `https://github.com/${repository}/actions/workflows/${definition.workflow}`,
    steps: [],
    error: null,
  };

  if (!token) {
    return {
      ...base,
      error: "Worker 未配置 GitHub Actions 状态查询令牌",
    };
  }

  try {
    const headers = githubHeaders(token);
    const runsResponse = await fetchImpl(
      `https://api.github.com/repos/${repository}/actions/workflows/${definition.workflow}/runs?branch=main&per_page=1`,
      { headers, cf: { cacheTtl: 30 } }
    );
    if (!runsResponse.ok) {
      throw new Error(`GitHub Actions HTTP ${runsResponse.status}`);
    }
    const runPayload = await runsResponse.json();
    const run = runPayload.workflow_runs?.[0];
    if (!run) {
      return { ...base, error: "尚未找到工作流运行记录" };
    }

    const jobsResponse = await fetchImpl(
      `https://api.github.com/repos/${repository}/actions/runs/${run.id}/jobs?per_page=20`,
      { headers, cf: { cacheTtl: 30 } }
    );
    let steps = [];
    let jobsError = null;
    if (jobsResponse.ok) {
      const jobsPayload = await jobsResponse.json();
      steps = (jobsPayload.jobs || []).flatMap((job) =>
        (job.steps || []).map((step) => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
          startedAt: step.started_at,
          completedAt: step.completed_at,
          durationMs: durationBetween(step.started_at, step.completed_at),
        }))
      );
    } else {
      jobsError = `步骤详情 HTTP ${jobsResponse.status}`;
    }

    return {
      ...base,
      status: statusForRun(run.status, run.conclusion),
      conclusion: run.conclusion,
      event: run.event,
      runId: run.id,
      runNumber: run.run_number,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      durationMs: durationBetween(run.run_started_at || run.created_at, run.updated_at),
      url: run.html_url || base.url,
      steps,
      error: jobsError,
    };
  } catch (error) {
    return {
      ...base,
      error: String(error?.message || error),
    };
  }
}

async function probeJSON(label, url, fetchImpl) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload !== "object") {
      throw new Error("返回内容不是 JSON 对象");
    }
    return {
      id: label,
      label,
      url,
      status: "success",
      latencyMs,
      generatedAt: payload.generatedAt || null,
      total: numberOrNull(payload.total),
      online: numberOrNull(payload.online),
      offline: numberOrNull(payload.offline),
      error: null,
    };
  } catch (error) {
    return {
      id: label,
      label,
      url,
      status: "failure",
      latencyMs: Date.now() - startedAt,
      generatedAt: null,
      total: null,
      online: null,
      offline: null,
      error: String(error?.message || error),
    };
  }
}

function workflowCheck(workflow, title, detail) {
  const failedStep =
    workflow.steps.find((step) => step.conclusion === "failure") ||
    workflow.steps.find((step) => step.conclusion === "cancelled");
  return {
    id: workflow.id === "monitor" ? "monitor" : "worker-deploy",
    title,
    status: workflow.status,
    detail: failedStep
      ? `${detail}失败于“${failedStep.name}”`
      : workflow.error ||
        (workflow.runNumber ? `${detail} #${workflow.runNumber}` : detail),
    latencyMs: null,
    checkedAt: workflow.updatedAt,
    href: workflow.url,
  };
}

function probeCheck(probe, title, detail) {
  return {
    id: probe.id === "页面数据" ? "pages" : probe.id,
    title,
    status: probe.status,
    detail:
      probe.status === "success"
        ? `${detail} 可读取`
        : `${detail} 读取失败：${probe.error}`,
    latencyMs: probe.latencyMs,
    checkedAt: new Date().toISOString(),
    href: probe.url,
  };
}

function combineCOSChecks(data, api) {
  const successCount = [data, api].filter(
    (probe) => probe.status === "success"
  ).length;
  const status =
    successCount === 2 ? "success" : successCount === 1 ? "warning" : "failure";
  const errors = [data, api]
    .filter((probe) => probe.error)
    .map((probe) => `${probe.label}：${probe.error}`);
  return {
    id: "cos",
    title: "COS 镜像",
    status,
    detail:
      status === "success"
        ? "监测数据与 API 快照均可公开读取"
        : errors.join("；") || "COS 数据不完整",
    latencyMs: Math.max(data.latencyMs, api.latencyMs),
    checkedAt: new Date().toISOString(),
    href: data.url,
  };
}

function snapshotFromProbe(id, label, probe) {
  return {
    id,
    label,
    status: probe.status,
    generatedAt: probe.generatedAt,
    latencyMs: probe.latencyMs,
    total: probe.total,
    online: probe.online,
    offline: probe.offline,
    url: probe.url,
    error: probe.error,
  };
}

function statusForRun(status, conclusion) {
  if (status === "completed") {
    if (conclusion === "success") return "success";
    if (conclusion === "failure") return "failure";
    if (conclusion === "cancelled") return "warning";
    return "warning";
  }
  if (status === "in_progress" || status === "queued") return "running";
  return "unknown";
}

function summaryFor(overall, attention) {
  if (overall === "healthy") {
    return {
      label: "整条链路运行正常",
      detail: "检测、页面发布、COS 镜像与自有 API 均已通过。",
    };
  }
  if (overall === "degraded") {
    return {
      label: "链路可用，但需要关注",
      detail: `${attention.map((item) => item.title).join("、")}存在警告、未知状态或正在更新，建议查看下方运行步骤。`,
    };
  }
  return {
    label: "链路存在失败节点",
    detail: `优先检查 ${attention.map((item) => item.title).join("、")} 的失败详情。`,
  };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "firepick-source-monitor-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function durationBetween(start, end) {
  if (!start || !end) return null;
  const elapsed = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时`;
}

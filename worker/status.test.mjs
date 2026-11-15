import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemStatus } from "./status.mjs";

const generatedAt = "2026-11-15T09:35:00.000Z";
const checkedAt = new Date("2026-11-15T09:40:00.000Z");

function mockFetch({ monitorFailure = false, cosAPIFailure = false } = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes("/workflows/monitor.yml/runs")) {
      return Response.json({
        workflow_runs: [
          {
            id: 101,
            run_number: 21,
            status: "completed",
            conclusion: monitorFailure ? "failure" : "success",
            event: "workflow_dispatch",
            created_at: "2026-11-15T09:31:00.000Z",
            run_started_at: "2026-11-15T09:31:05.000Z",
            updated_at: "2026-11-15T09:34:00.000Z",
            html_url: "https://github.com/example/actions/runs/101",
          },
        ],
      });
    }
    if (href.includes("/workflows/deploy-worker.yml/runs")) {
      return Response.json({
        workflow_runs: [
          {
            id: 202,
            run_number: 8,
            status: "completed",
            conclusion: "success",
            event: "push",
            created_at: "2026-11-15T09:31:00.000Z",
            updated_at: "2026-11-15T09:33:00.000Z",
            html_url: "https://github.com/example/actions/runs/202",
          },
        ],
      });
    }
    if (href.includes("/actions/runs/101/jobs")) {
      return Response.json({
        jobs: [
          {
            steps: [
              {
                number: 1,
                name: "Probe CMS sources",
                status: "completed",
                conclusion: monitorFailure ? "failure" : "success",
                started_at: "2026-11-15T09:31:10.000Z",
                completed_at: "2026-11-15T09:32:40.000Z",
              },
              {
                number: 2,
                name: "Deploy GitHub Pages",
                status: "completed",
                conclusion: monitorFailure ? "skipped" : "success",
                started_at: monitorFailure ? null : "2026-11-15T09:32:41.000Z",
                completed_at: monitorFailure ? null : "2026-11-15T09:32:50.000Z",
              },
            ],
          },
        ],
      });
    }
    if (href.includes("/actions/runs/202/jobs")) {
      return Response.json({
        jobs: [
          {
            steps: [
              {
                number: 1,
                name: "Deploy Worker and cron trigger",
                status: "completed",
                conclusion: "success",
                started_at: "2026-11-15T09:32:00.000Z",
                completed_at: "2026-11-15T09:32:30.000Z",
              },
            ],
          },
        ],
      });
    }
    if (cosAPIFailure && href.includes("/api/v1/stats.json")) {
      return new Response("unavailable", { status: 503 });
    }
    if (
      href.includes("/data/stats.json") ||
      href.includes("/api/v1/stats.json")
    ) {
      return Response.json({
        generatedAt,
        total: 206,
        online: 70,
        offline: 136,
      });
    }
    return new Response("not found", { status: 404 });
  };
}

test("builds an end-to-end healthy status with workflow steps", async () => {
  const status = await buildSystemStatus({
    env: {
      WORKFLOW_DISPATCH_TOKEN: "token",
      API_DATA_ORIGIN: "https://cos.example/firepick-monitor",
    },
    fetchImpl: mockFetch(),
    now: () => checkedAt,
  });

  assert.equal(status.overall, "healthy");
  assert.equal(status.summary.label, "整条链路运行正常");
  assert.equal(status.checks.length, 5);
  assert.equal(status.consistency.status, "success");
  assert.equal(status.snapshotAt, generatedAt);
  assert.equal(status.workflows[0].steps.length, 2);
  assert.equal(status.workflows[0].steps[0].name, "Probe CMS sources");
  assert.equal(status.snapshots.length, 3);
});

test("reports the failed workflow step and incomplete COS mirror", async () => {
  const status = await buildSystemStatus({
    env: {
      WORKFLOW_DISPATCH_TOKEN: "token",
      API_DATA_ORIGIN: "https://cos.example/firepick-monitor",
    },
    fetchImpl: mockFetch({ monitorFailure: true, cosAPIFailure: true }),
    now: () => checkedAt,
  });

  assert.equal(status.overall, "failed");
  const monitor = status.checks.find((item) => item.id === "monitor");
  assert.equal(monitor.status, "failure");
  assert.match(monitor.detail, /Probe CMS sources/);
  const cos = status.checks.find((item) => item.id === "cos");
  assert.equal(cos.status, "warning");
  assert.match(cos.detail, /COS API/);
});

test("degrades the overall status when workflow details are unavailable", async () => {
  const status = await buildSystemStatus({
    env: {
      API_DATA_ORIGIN: "https://cos.example/firepick-monitor",
    },
    fetchImpl: mockFetch(),
    now: () => checkedAt,
  });

  assert.equal(status.overall, "degraded");
  const monitor = status.checks.find((item) => item.id === "monitor");
  assert.equal(monitor.status, "unknown");
  assert.match(status.summary.detail, /线路检测/);
});

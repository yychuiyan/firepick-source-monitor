# Firepick Source Monitor

定时检测 AppleCMS 采集站，并生成拾萤可读取的候选池、在线状态和
HLS 清晰度报告。

## Output

```text
public/data/latest.json
public/data/online.json
public/data/quality.json
public/data/cms-candidates.json
public/data/stats.json
```

## Local probe

```bash
npm run probe
```

Useful overrides:

```bash
PROBE_CONCURRENCY=6 \
PROBE_TIMEOUT_MS=8000 \
PLAYBACK_TIMEOUT_MS=5000 \
PROBE_KEYWORDS='庆余年,三体' \
QUALITY_PROBE_LIMIT=18 \
npm run probe
```

The probe checks list, search, detail, playable URL, and HLS master variant
`RESOLUTION` / `BANDWIDTH`. It does not download full media.

## GitHub Pages

The workflow runs every two hours and deploys `public/` as a static site.

## Cloudflare Pages

Cloudflare can deploy the same generated directory:

```bash
npx wrangler pages deploy public --project-name firepick-source-monitor
```

Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in GitHub Secrets.

## Tencent COS mirror

Upload generated files after the probe:

```bash
coscli cp public/data/quality.json \
  cos://BUCKET/firepick-monitor/quality.json \
  --acl public-read \
  --meta 'Content-Type:application/json;charset=utf-8#Cache-Control:no-cache, max-age=0'
```

Keep COS credentials in GitHub Secrets. Use a restricted sub-account that can
only write `firepick-monitor/*`.

Firepick should read Cloudflare first, then COS, then its bundled fallback.

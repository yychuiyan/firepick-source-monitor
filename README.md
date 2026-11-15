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

Recommended production domain:

```text
sources.yychuiyan.com
```

Production files:

```text
https://sources.yychuiyan.com/data/cms-candidates.json
https://sources.yychuiyan.com/data/quality.json
https://sources.yychuiyan.com/data/stats.json
```

COS production mirror:

```text
https://firepick-1302621537.cos.ap-shanghai.myqcloud.com/firepick-monitor/data/cms-candidates.json
https://firepick-1302621537.cos.ap-shanghai.myqcloud.com/firepick-monitor/data/quality.json
https://firepick-1302621537.cos.ap-shanghai.myqcloud.com/firepick-monitor/data/stats.json
```

Recommended Cloudflare Pages project:

```text
firepick-source-monitor
```

Create the Pages project once, then add `sources.yychuiyan.com` as its custom
domain. Add these GitHub Secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The workflow deploys Cloudflare Pages automatically when both secrets exist.
It can also be deployed manually:

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

Add these secrets to enable automatic COS mirroring:

```text
COS_SECRET_ID
COS_SECRET_KEY
COS_BUCKET
COS_REGION
```

Firepick reads COS first, then Cloudflare, then its bundled fallback.

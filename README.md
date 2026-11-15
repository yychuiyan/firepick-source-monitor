# 拾萤线路检测

面向拾萤的采集线路监控项目。它会自动发现可用采集站，定时检测线路状态、
视频接口、播放地址和画质信息，并为拾萤生成可直接读取的候选线路数据。

监测结果同时提供网页面板，可查看站点描述、标签、在线状态、响应延迟、
HLS 清晰度、目录评分和综合评分，并支持状态筛选与多条件排序。

## 工作流程

每次检测会执行以下步骤：

1. 从拾萤上次成功发布的目录、本地种子池和 `submissions.json` 加载已知站点。
2. 从 `discovery-sources.json` 配置的公开代码仓库、TVBox/CatVod 配置、
   目录、Sitemap、搜索 API、Common Crawl 和证书透明度中提取新的
   AppleCMS 接口，不依赖外部资源站目录 API。
3. 按域名合并去重；`exclusions.json` 中确认不可用的域名不会再次并入。
4. 为名称、描述或标签中命中成人关键词的站点写入 `adult: true`，不直接删除。
5. 检查采集站列表接口、关键词搜索和详情接口。
6. 从详情数据提取可播放地址；对 HLS 地址继续读取主播放列表中的
   `RESOLUTION` 和 `BANDWIDTH`，不会下载完整视频。
7. 维护自己的目录、首次发现时间、在线/离线次数和最近状态时间。
8. 按接口可用性、搜索结果、详情、播放地址、清晰度、延迟和评分计算综合分。
9. 生成在线、离线、画质、最快、评分最高、最佳线路和 `/api/v1` 数据。

默认检测关键词为“庆余年”和“三体”。HLS 信息取决于采集站是否直接提供
主播放列表；不提供时，画质记为未知，但仍会保留线路的可用性数据。

## 生成数据

检测结果写入 `public/data/`：

```text
latest.json          全部检测结果与汇总信息
latest.js            网页内嵌的最新检测结果
online.json          完整可用线路
offline.json         检测失败线路及原因
quality.json         已识别清晰度的可用线路
cms-candidates.json  供拾萤读取的可用采集站候选池
fastest.json         列表接口响应最快的在线线路
top-rated.json       目录评分最高的线路
best.json            供拾萤快速复测的域名去重最佳线路
stats.json           总量、在线率、延迟与画质统计
catalog.json         拾萤自有站点目录与持续累计的检测历史
archive.json         本轮未参与主动检测的轮换或死链历史
```

`cms-candidates.json` 只包含线路标识、名称和接口地址，适合直接用于拾萤的
候选线路池。其他文件用于面板展示、问题排查和线路质量分析。

## 本地运行

需要 Node.js 20 或更高版本：

```bash
npm run check
npm run probe
```

启动本地网页：

```bash
cd public
python3 -m http.server 8765 --bind 127.0.0.1
```

然后打开 <http://127.0.0.1:8765/>。

可通过环境变量调整检测行为：

```bash
PROBE_CONCURRENCY=6 \
PROBE_TIMEOUT_MS=8000 \
PLAYBACK_TIMEOUT_MS=5000 \
PROBE_KEYWORDS='庆余年,三体' \
QUALITY_PROBE_LIMIT=18 \
DISCOVERY_LIMIT=240 \
FRESH_DISCOVERY_RESERVE=40 \
DEAD_LINK_AFTER_DAYS=30 \
npm run probe
```

设置 `DISCOVERY=off` 可关闭互联网发现，但仍会检测自有目录、种子池和提交队列。
GitHub Actions 会自动注入 `GITHUB_TOKEN` 用于公开配置仓库发现；本地运行时
也可以自行设置，未设置时会使用 GitHub 的匿名限额。

发现器已接入以下渠道：

- GitHub 仓库搜索、代码搜索和指定 TVBox 配置仓库；
- GitLab、Gitee、Codeberg 公开仓库搜索；
- `feedUrls`、`directoryUrls`、`sitemaps.urls` 中的公开配置和页面；
- Brave、Bing、Serper、Google Custom Search、Tavily 和 SearXNG；
- Common Crawl 索引；
- Certificate Transparency 新域名；
- `submissions.json` 用户提交队列。

搜索 API 只有在配置对应 GitHub Actions Secrets 后才会启用：

```text
GITEE_TOKEN
CODEBERG_TOKEN
BRAVE_SEARCH_API_KEY
BING_SEARCH_API_KEY
SERPER_API_KEY
GOOGLE_CUSTOM_SEARCH_API_KEY
GOOGLE_CUSTOM_SEARCH_ENGINE_ID
TAVILY_API_KEY
```

SearXNG 只需在 `discovery-sources.json` 的 `searchApi.searxngURL` 中填写实例
地址。Common Crawl 的通配查询资源消耗较高，默认关闭；需要时把
`commonCrawl.enabled` 改为 `true`。

`exclusions.json` 用于持久排除已确认无法兼容或已经下线的接口。不要把
“测试关键词无搜索结果”或单次网络超时直接加入排除清单；这些线路仍应参与
后续复测。删除对应域名条目后，该线路可以在下一轮自动发现中重新进入。

新的候选站可以加入 `submissions.json`，也可在 `discovery-sources.json` 中增加
公开配置地址或 GitHub 仓库。发现器只提取含有 AppleCMS 接口特征的 URL，
候选站仍需通过完整检测后才会进入在线池和最佳线路。

每轮检测最多选择 `240` 个候选，但固定种子和当前在线线路始终保留，并优先
预留最多 `40` 个位置给从未见过的新候选。剩余位置按最近在线时间优先分配给
可能临时波动的离线站。只有同时满足“至少 3 次检测失败”和“连续 30 天没有
一次在线成功”的线路才会标记为死链，并退出主动检测；这些线路仍保留在
`catalog.json` 和 `archive.json` 中，不会丢失历史。新候选通过完整检测后会
自动补入在线池，失败候选不会挤掉现有正常线路。

## 自有 API

检测任务会同时生成静态 API 快照和 Cloudflare Worker 数据源。当前可直接读取：

```text
https://sources.yychuiyan.com/api/v1/best.json
https://sources.yychuiyan.com/api/v1/sources.json
https://sources.yychuiyan.com/api/v1/monitor.json
https://sources.yychuiyan.com/api/v1/stats.json
https://sources.yychuiyan.com/api/v1/defunct.json
https://sources.yychuiyan.com/api/v1/cms-candidates.json
https://sources.yychuiyan.com/api/v1/openapi.json
```

Worker 版本提供无后缀路由、分页、筛选和搜索：

```text
GET /api/v1/sources?status=online&adult=false&sort=score&page=1
GET /api/v1/sources/{id}
GET /api/v1/search?q=魔都
GET /api/v1/best?mode=standard
GET /api/v1/best?mode=adult
GET /api/v1/status
GET /api/v1/probe?ids=zuid_me,wujin_com
```

`/api/v1/status` 会检查最近一次线路检测工作流、GitHub Pages、COS 数据与
COS API 快照，并返回每一步工作流的结论。网页面板的“系统状态”菜单会将该
结果渲染为端到端链路；某一步失败时可以直接看到失败步骤和耗时。

线路池的“读取快照”只重新读取最近一次检测并发布的数据；“速度测试”会
按每批最多 20 条连续通过 Worker 请求当前筛选结果的全部采集列表接口，更新
响应时间与在线状态，并按当前排序重新排列。即时复测不替代每 15 分钟的完整
检测和画质探测。

本地运行 API：

```bash
npm run api:dev
```

Worker 使用 `public/` 作为静态资源，并由 `run_worker_first` 接管
`/api/v1/*`。`wrangler.toml` 已配置 `sources.yychuiyan.com/api/v1/*`
路由；配置 Cloudflare 凭据后可以执行 `npm run api:deploy`。部署前的
`.json` 静态路由仍可由 GitHub Pages 或 COS 直接读取。

监控任务会把 `public/api/v1/*.json` 同步到 COS，Worker 优先读取这份最新
快照，并在 COS 暂时不可用时回退到部署内置的 API 数据。这样无需每 15 分钟
重新部署 Worker，同时能保持自定义域名 API 与监控结果同步。

Worker 同时配置了每 15 分钟一次的 Cron Trigger，作为 GitHub Actions
定时调度的独立兜底。部署前需要配置一个仅允许该仓库 `Actions: write`
的 GitHub Token：

```bash
npx wrangler secret put WORKFLOW_DISPATCH_TOKEN
npm run api:deploy
```

Cron 触发时，Worker 会调用 GitHub `workflow_dispatch` 启动 `monitor.yml`。
也可以在 GitHub Actions 中运行 `deploy-worker` 工作流完成部署。运行前需
添加以下仓库 Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `WORKFLOW_DISPATCH_TOKEN`

## 网页面板

`public/index.html` 提供浅色和深色主题，首次访问跟随系统设置，之后会记住
用户选择。面板以“线路观测台”的方式组织信息，支持：

- 总览健康度、线路状态脉冲和本次检测指标；
- 按名称、域名、描述或标签搜索，按状态和标签筛选；
- 按综合分、响应、稳定性和资源量等维度排序；
- 卡片与表格两种视图，以及表格分页；
- 响应速度、目录可用率、评分和资源量分布；
- 响应最快、资源最多和今日更新排行；
- 线路详情、接口复制、收藏和候选池下载；
- 适配桌面和移动端的响应式布局。

页面目前只展示单次检测快照，不会把单次结果包装成历史趋势。历史可用率
曲线需要后续持续积累快照并生成独立的趋势数据。

## 自动发布

GitHub Actions 工作流位于 `.github/workflows/monitor.yml`，会在以下时机运行：

- 每 15 分钟定时检测；
- 推送到 `main` 分支时；
- 手动触发时。

检测完成后，`public/` 会发布到 GitHub Pages。网页地址为：

<https://sources.yychuiyan.com/>

工作流可在配置对应 Secrets 后同时发布到 Cloudflare Pages 和腾讯云 COS。
未配置的服务会自动跳过。

### Cloudflare Pages

在 GitHub 仓库 Actions Secrets 中配置：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Cloudflare Pages 项目名称为 `firepick-source-monitor`。如需手动发布：

```bash
npx wrangler pages deploy public \
  --project-name firepick-source-monitor
```

### 腾讯云 COS

在 GitHub 仓库 Actions Secrets 中配置：

```text
COS_SECRET_ID
COS_SECRET_KEY
COS_BUCKET
COS_REGION
```

工作流会上传 `public/data/*.json` 和 `public/api/v1/*.json`，目标路径为：

```text
firepick-monitor/data/
firepick-monitor/api/v1/
```

当前公开镜像地址：

```text
https://firepick-1302621537.cos.ap-shanghai.myqcloud.com/firepick-monitor/data/
```

上传后会读取公开的 `stats.json` 校验同步结果。拾萤读取线路数据时优先使用
COS，再回退到网站接口或随应用打包的默认候选池。

## 密钥安全

仓库中不保存任何云服务密钥，所有凭据都应放入 GitHub Actions Secrets。
GitHub 会在工作流日志中隐藏 Secret 值，工作流也不会在不可信 Pull Request
中执行发布步骤。

建议为 COS 创建专用子账号，仅授予 `firepick-monitor/*` 下对象的上传和
公有读权限。不要授予整桶删除、账号管理或密钥管理权限。临时配置文件由
工作流写入运行器临时目录，不应提交到仓库。

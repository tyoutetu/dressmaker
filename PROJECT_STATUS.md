# Project Status — dressmaker

> 建档 2026-10-03。来自只读检查（README、源码、git 元数据、线上 URL 探测）。
> **建档时未运行** `npm install` / `npm run build` / 任何测试命令。凡未实测的一律标「未登记」。

## 项目是什么

一句话：把玩家在游戏 *Dressmaker* 里做的裙子截图，生成「某位顾客穿上这条裙子」的
AI 预览图（**非官方粉丝 beta**）。

README 定位原文要点：
- 上传你在 *Dressmaker* 里做的裙子的截图，选一位顾客，生成该顾客穿着这条裙子的 AI 预览。
- 只有两位有真实美术素材的顾客启用：**Rose** 与 **Priya**。其他名字不显示 —— README 的说法是，
  UI 里出现别的名字就等于放一个「假装是角色的占位符」。
- 自我声明：unofficial, fan-made beta；*Dressmaker* 及其角色、美术归各自权利人；
  预览是实验性的，不会与游戏内结果一致；应用本身不保存上传的截图文件，
  截图会发给所配置的 AI 提供方用于生成预览。

技术栈（读自 `api/package.json`、`web/package.json`，**未运行构建**）：
- API：Vercel Functions（TypeScript / ESM），依赖 `@neondatabase/serverless`、`openai`、
  `@google/genai`、`sharp`；数据库 Postgres（Neon），额度预留由
  `reserve_generation_quota(...)` 单条 SQL 完成
- 前端：Vite + React 19 静态站点，由同一个 Vercel 项目构建并托管（`web/dist`）

仓库：`git@github.com:tyoutetu/dressmaker.git`

### 子目录分工

| 目录 | 分工 |
|---|---|
| `api/` | **只有 4 个 handler**（`generate` / `quota` / `feedback` / `health`）—— Vercel 只把这里的文件变成函数 |
| `lib/` | 共享服务端代码：`npcs` / `quota` / `ip` / `db` / `providers` / `validation` / `prompt` / `output` / `body` / `env` / `config` / `errors` / `npcAssets` |
| `assets/npcs/` | 发给模型的顾客参考图（`rose.webp`、`priya.webp`），在 `api/` 之外所以不会被公开 |
| `sql/schema.sql` | Postgres schema + 额度预留函数 |
| `scripts/` | 本地 mock、db 初始化、付费质量 spike（`mock-server.ts` / `db-init.ts` / `spike.ts`） |
| `tests/` | handler、配额 SQL、provider、prompt、来源校验测试（15 个 `*.test.ts`） |
| `vercel.json` | 单项目配置：installCommand / buildCommand / outputDirectory / functions |
| `web/` | 前端（Vite + React），构建到 `web/dist`，与 API 同项目同源 |
| `web/public/npcs/` | 顾客选择卡片上显示的同一批立绘 |
| `web/src/lib/qr.ts` | 无依赖 QR 编码器（分享卡用，byte 模式、level M、版本 1–10） |
| `web/src/lib/shareCard.ts` | canvas 合成可分享 PNG |
| `shared/` | ⚠️ **空目录**。`git ls-files shared` 无输出，README 未提及，全仓库无引用 → **用途未登记** |
| `spike-out/` | 付费 spike 输出（已 gitignore） |
| `test-dresses/` | 付费 spike 的本地输入素材（已 gitignore） |

`lib/npcs.ts` 是顾客列表的唯一事实来源，web 构建再导出它。

## 最近完成

倒序。**建档时未运行任何构建/测试**，故区分「建档实测」与「仓库内既有证据」。

### 2026-10-03 — 修复线上函数全部 500（ESM 扩展名）+ 生产环境首次成功出图

- 提交 `7a99135`（另含 `33a3379` 的 QUOTA_UNLIMITED_IPS）
- **现象**：`/api/health` 与 `/api/quota` 均返回 500 `FUNCTION_INVOCATION_FAILED`。
  表面看一切正常：构建绿、部署 READY、函数数正好 4——**但 4 个函数一个都跑不起来。**
- **真因（`vercel logs` 原文）**：
  ```
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/lib/errors'
    imported from '/var/task/api/quota.js'
  ```
  Vercel 把 TS **逐个编译成独立 ESM `.js`（不打包）**，而 Node ESM **不做扩展名推断**，
  所以 `../lib/env` 这类无扩展名相对导入永远解析不到，函数在模块加载阶段就崩。
- **修法**：
  - 34 个文件的相对导入补 `.js`（`api/` `lib/` `scripts/` `tests/`）
  - `web/src/lib/shareCard.ts` 的 `./qr` → `./qr.js`（被 tests 经 `.js` 拉进根 tsconfig）
  - **`tsconfig.json` 的 `module`/`moduleResolution` 由 `Bundler` 改为 `NodeNext`**
    —— 把编译器和运行时对齐，以后漏扩展名会在 `npm run typecheck` 直接报 TS2835，
    而不是等线上 500
- **教训（重要）**：**构建绿 + 部署 READY + 函数数正确，都不等于函数能跑。**
  此前多轮把「构建成功/部署 READY/环境变量就位」当作验证结论，那些都是必要条件而非充分条件；
  唯一能证明函数可用的是**真的调用一次端点**。
- **验证（生产环境实测，非推测）**：
  - `/api/health` → 200 `{"ok":true,"provider":"qwen","db":true,"quotaConfigured":true}`
  - `/api/quota` → 200，`limit:100, network_remaining:100`
  - **真实生成成功**：上传 `test-dresses/dress5.png` → Rose 出图 1024×1024 PNG(~1MB)，
    耗时 22 秒，配额 100 → 99；渐变裙、金边、蓝蝴蝶结均忠实迁移，Rose 身份保持
  - 截图存档：`spike-out/live-real-result.png`、`spike-out/live-quota-fixed.png`
- **踩到的坑（工具层）**：Playwright 的 `page.request.get()` **不走浏览器自身的代理/VPN**，
  所以用它会误判「站点不可达」。要用 `page.goto()` 走真实浏览器网络栈——
  此前据此得出「你的浏览器没走 VPN」的结论是错的。

### 2026-10-03 — QUOTA_UNLIMITED_IPS：仅豁免指定网络的每网络上限

- 提交 `33a3379`
- 背景：用户要「我自己测试不受限、其他人保持 3 次」，而我先做成了对所有人放开（理解偏了），
  已按原意重做
- `readQuotaLimits(env, { unlimitedNetwork })` 只抬高「每网络」这一个数字到全局预算为止；
  **全局上限原样不动，所以豁免不增加当日最坏花费**
- **精确地址匹配而非网段**：网段匹配会把共享同一出口的陌生人一起豁免
- `GLOBAL_DAILY_GENERATION_LIMIT=0` 的全局开关对豁免网络同样有效
- 生产实测：`64.118.152.55` 显示 `100 of 100`（豁免生效），其他人仍为 3

### 2026-10-03 — 接入 Neon：schema 随部署自动应用

- 提交 `190cdc9`（`vercel.json` 的 `buildCommand` 前置 `npm run db:init`；README 同步）
- **背景（实测，两条路都不通）**：Vercel 的 Neon 集成把 `DATABASE_URL` 建为
  `type: sensitive`。REST API `GET /v1/projects/{id}/env/{envId}?decrypt=true` 返回空值；
  `vercel env pull` 对 18 个变量一律写 `[SENSITIVE]` 占位符。
  **密钥在设计上就取不出来**，因此 agent 无法直接执行 `db:init`，
  线上会因缺表而 fail-closed 返回 503。
- **解法**：把建表接进部署流程。`sql/schema.sql` 本就是幂等的
  （文件内注明 safe to apply repeatedly），所以每次部署自动对齐表结构，
  不需要任何人持有或转交数据库密钥。
- **验证（构建日志原文，非推测）**：
  ```
  > dressmaker-preview-api@0.1.0 db:init
  > node --env-file-if-exists=.env --import tsx scripts/db-init.ts
  Schema applied: generations, feedback, usage_daily, global_usage_daily, reserve_generation_quota().
  ```
  这一行同时证明：连接串有效、Neon 从 Vercel 可达、4 张表已建、配额函数已建。
  `db-init.ts` 失败即 `exit 1`，构建成功本身即是它没出错的证据。
- **代价（有意取舍）**：部署现在依赖数据库可达。宁可部署失败，
  也不要发布一个连不上自己数据库的构建——与本项目 fail-closed 的一贯取向一致。

### 2026-10-03 — 部署架构迁移：GitHub Pages + Vercel 双项目 → Vercel 单项目

- 提交 `4acf8e8`（重构）、`ea97f5a`（合并）、`8b6e26c`（来源校验修复）
- **动机**：前后端本就都需要 Vercel，分两个平台还要额外维护 CORS 与 API 地址配置。
  单项目同源可彻底去掉这两样。用户明确要求「一个项目」。
- **根因（实测，非推测）**：Vercel 会把项目根 `api/` 下**每个** `.ts` 变成函数。
  旧布局（`api/api` + `api/lib` + `api/scripts` + `api/tests`）在根目录下产生
  **37 个函数**，直接顶爆 Hobby 版上限——实测部署报错原文：
  ```
  exceeded_serverless_functions_per_deployment
  No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan.
  ```
  构建日志里 `Using TypeScript` 恰好出现 37 次。**这就是当初 Root Directory 必须设 `api` 的原因。**
- **新布局**（常规 Vercel 单项目）：
  | 路径 | 内容 |
  |---|---|
  | `api/*.ts` | 4 个 handler（= 4 个函数，唯一会变函数的地方） |
  | `lib/` | 共享代码（函数目录之外） |
  | `assets/npcs/` | 参考图 |
  | `sql/` `scripts/` `tests/` | schema、本地脚本、测试 |
  | `web/` | 前端，构建到 `web/dist` |
  | `vercel.json` | installCommand / buildCommand / outputDirectory / functions |
- **改动要点**：全部用 `git mv` 整体位移，故 handler 与测试里的 `../lib/...` 相对路径
  **无需改动**；实际只影响 4 行跨目录引用（`tests/{web-logic,qr-share}.test.ts` 的
  `../../web` → `../web`）、`web/src/npcs.ts` 与 `web/tsconfig.json` 指向的
  `lib/npcs.ts`。**`web/src/npcs.ts` 那处是构建时才暴露的**——说明搬完必须真跑构建。
- **API base 语义变更**：空 `VITE_API_BASE` 现在表示**同源**而非「未配置」。
  移除了 `isApiConfigured` 与 5 处 `config_missing` 守卫（同源下那是冗余门控，
  可达性由 `/api/health` 与 quota 是否 `fresh` 回答）。
- **同源带来的一个必要修复**：`isOriginAllowed` 原先在 `ALLOWED_ORIGINS` 为空时
  拒绝一切浏览器来源，而**同源 POST 同样会带 `Origin` 头** → 不修则部署后每个生成请求 403。
  现在 `lib/env.ts` 通过 Vercel 系统变量 `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`
  自动接受自身部署域名（含 preview）。新增 `tests/env.test.ts` 7 条覆盖。
- **Vercel 侧**：新建项目 `dressmaker`（`prj_1FEUfj463svOURMBTgFNSpgeqRuN`，
  **root = 仓库根**），连接 GitHub `tyoutetu/dressmaker` @ `main`，写入 9 个环境变量；
  **旧项目 `dressmaker-api` 已删除**。
- **生产域名**：`https://dressmaker-rouge.vercel.app`
  ⚠️ `dressmaker.vercel.app` **已被他人占用**，Vercel 自动分配了 `-rouge` 后缀。
  该地址已写入 `VITE_SITE_URL`（分享二维码指向它）。
- **验证**：151 项测试全过（原 144）、根类型检查通过、前端构建通过、
  mock 能从新根启动、部署 `READY`、构建日志确认**函数数 = 4**、前端 `dist/` 产物已生成、
  9 个环境变量逐条核对。
- ⚠️ **仍无法从国内做端到端验证**：`dressmaker-rouge.vercel.app` 实测 `http=000`，
  对照组 `tyoutetu.github.io/dressmaker/` 为 **200**。详见下方「已知问题」。

### 2026-10-03 — 部署：Vercel API 项目已建并成功部署（但国内不可达）

- **不是提交**，是基础设施操作，无代码改动
- 做了什么：
  - 创建 Vercel 项目 `dressmaker-api`（id `prj_fFbbEq4J6gmAzmfkcmLFPa1Jee6Y`），
    **Root Directory = `api`**（必须如此：`api/api/` 才是函数目录，`api/lib`、`api/tests`、
    `api/scripts` 必须留在函数目录之外，否则约 37 个 `.ts` 都会被当成函数，超 Hobby 版 12 个上限）
  - 连接 GitHub `tyoutetu/dressmaker` @ `main` → **以后 push 自动部署**
  - 写入 8 个环境变量（`DASHSCOPE_API_KEY`、`IP_HASH_SECRET` 为加密类型）
  - 触发生产部署 `dpl_GBbGnpGFp9WkDZ9oudUombSmHbAT` → **READY**
  - 域名：`https://dressmaker-api.vercel.app`
- 怎么验证的：Vercel API 查 `readyState = READY` + 构建日志含 `Deployment completed`
- ⚠️ **未做端到端验证，且当前网络做不到**：`*.vercel.app` 从这台机器**完全不可达**，实测
  1. 本地 DNS 解析到 `157.240.17.35`（**Facebook 的 IP 段**）
  2. Google DNS `8.8.8.8` 解析到 `168.143.162.58`（也不是 Vercel）
  3. 用真实 IP `76.76.21.21` 直连 → `Connection reset by peer`（**SNI 层阻断**）
  4. 浏览器通道（Tabbit）同样超时
  5. 对照组：`tyoutetu.github.io` → **200**；`api.vercel.com` → 可达；
     用户自定义域名 `www.museaiguide.online`（同样指向 Vercel）→ **301 可达**
  → 结论：**GFW 阻断，非配置问题**。这很可能正是该用户名下所有项目都挂自定义域名的原因。
- **仍缺 `DATABASE_URL`**：Neon 库未建。Vercel CLI 无法创建（`storage create` 只支持
  `blob` / `global-config`；`integration resource` 只有 connect/disconnect/remove/inspect，
  没有 create），必须在 Vercel 网页建
- 坑：Vercel CLI 的 OAuth token 无法在 agent 沙箱里使用——刷新时要把新 token 写回
  `~/Library/Application Support/com.vercel.cli/auth.json`（工作区外，被拒），
  而 Vercel 的 refresh token 是**一次性轮换**的，于是刷新成功一次后永久失效
  （`invalid_grant: Refresh token is invalid`）。**解法：改用 Personal Access Token + `--token`，
  完全不需要写配置文件。**

### 2026-10-02 — 付费 spike 三轮实测：裙子保真度 4/5 良好（¥3.30，非提交）

- 输入：5 张真实裙子截图（放在 `test-dresses/`，已 gitignore）
- 三轮对照，每轮 5 张 × ¥0.22 = ¥1.10，**合计 ¥3.30**
- 结论：**4/5 良好**（改前为 3/5）
  | 服装 | 原图袖型 | 改前 | 第一轮 | 第二轮 |
  |---|---|---|---|---|
  | dress1 | 无袖挂脖 | ❌ 残留长袖 | ❌ | ❌ **仍未解决** |
  | dress2 | 长黑袖 | ✓ | ✓ | ✓ |
  | dress3 | 长白袖 | ✓ | ✓ | ✓ |
  | dress4 | 短泡泡袖 | ❌ | ❌ | ✅ **修复** |
  | dress5 | 短蓝喇叭袖 | △ 叠袖 | ✅ | ✅ |
- 延迟：平均 15–16s（最快 11.8s，最慢 20.3s）→ **240s 超时余量充足，延迟风险解除**
- 副作用（已如实记录，未掩盖）：dress1 / dress3 领口出现 Rose 默认形象的**金色领结**，
  属新的配饰渗透；dress3 原图领口是白色蕾丝+绑带，该处因此偏离原图
- 产物：`spike-out/before/`（改前）、`spike-out/round1/`（第一轮）、`spike-out/`（第二轮）
- **这条解答了建档时标记的「保真度是否已确认：未登记」** —— 已确认，结论是 4/5，
  剩余问题是 dress1 的无袖挂脖款

### 2026-10-02 — 修复(prompt)：用 negative_prompt 抑制叠穿，不排除袖子本身

- 提交 `a38274f`（正文：`[用 negative_prompt 抑制叠穿（服装替换·第二轮）]`）
- 改了什么（7 文件，+77/-3）：`api/api/generate.ts`、`api/lib/prompt.ts`(+22)、
  `api/lib/provider.ts`、`api/lib/providers/qwen.ts`、`api/scripts/spike.ts`、
  `api/tests/prompt.test.ts`、`api/tests/qwen.test.ts`
- 为什么改：服装替换的第二轮问题 —— 叠穿
- 怎么验证的：提交内含 prompt / qwen 两处用例更新；**建档时未运行测试**；
  无线上核验记录 → 实测结果**未登记**

### 2026-10-02 — 新建(analytics)：分享链路 GA4 埋点

- 提交 `c98f01a`，改动 `web/src/components/ShareButton.tsx`、`README.md`
- 改了什么：新增 `share_clicked` / `share_completed` / `share_failed`，参数为低基数 `method`
  （`sheet` / `download`）与失败时的 `error_type`（`cancelled` / `rejected`）；
  README §9 补记分享成功率漏斗
- 怎么验证的：`web/src/lib/analytics.ts` 显示事件仅在 `window.gtag && GA_ID` 同时成立时才发出
  （未配 GA4 则静默）；**建档实测**线上 bundle（`index-BMf5rHbk.js`）含分享卡代码
  （`Share` / `1080` / `qr`），但**未发现** `share_clicked` 等字符串
  → 线上构建是否包含此提交：**未登记**（证据倾向「否」，未进一步核实）

### 2026-10-02 — 修复(prompt)：服装必须彻底替换，禁止残留角色原袖

- 提交 `292acf8`，改动 `api/lib/prompt.ts`(+14/-3)、`api/tests/prompt.test.ts`(+51/-3)
- 为什么改：服装替换不彻底（角色原袖子残留）
- 怎么验证的：附了 51 行新增用例；**建档时未运行** → 未登记

### 2026-10-02 — chore(repo)：忽略 .npm-cache / .vercel-cli / test-dresses

- 提交 `e2c3312`，改动 `.gitignore`(+14)。原因是 agent sandbox 下 npm cache / Vercel CLI
  只能装在仓库内
- **当前工作区仍有 1 处未提交改动**：`.gitignore`（新增忽略一条本地部署凭据文件）

### 2026-10-02 — 新建(share)：结果页分享卡片（站点 URL + 二维码）

- 提交 `b5e22af`（10 文件，+3162）：`web/src/App.tsx`、`components/Icons.tsx`、
  `components/ResultSection.tsx`、`components/ShareButton.tsx`、`web/src/lib/qr.ts`、
  `web/src/lib/shareCard.ts`、`web/src/styles.css`、`web/src/vite-env.d.ts`、
  `api/tests/qr-share.test.ts`、`.github/workflows/deploy-web.yml`
- 改了什么：结果页生成一张 1080×1350 PNG（预览图 + 站点地址 + 指向站点的二维码），
  全程在浏览器 canvas 完成；手机走系统分享面板，桌面走 `<a download>`；
  QR 静区按「模块数」而非像素计算
- 怎么验证的：`api/tests/qr-share.test.ts`（201 行）覆盖版本选择、定位图案、静区；
  README 另记「用 Chromium `BarcodeDetector` 独立解码回原 URL」的带外验证。**建档时未运行**

### 2026-10-02 — 补充(demo)：完成 Rose/Priya 试衣预览 Demo 与配额体系

- 提交 `f600149`：初版全量落库（README 426 行、`api/` 全部 handler / lib / providers / tests、
  `web/`、`.zcodeignore`、`api/.env.example`）

### 附带证据：付费 spike 已跑过一次（不是提交）

`spike-out/results.csv`（mtime 2026-10-02 23:28）记录了 5 条真实渲染：`dress1.jpg` 13.8s、
`dress2.webp` 14.9s、`dress3.webp` 12.7s、`dress4.webp` 14.9s、`dress5.png` 20.3s，
`est_cost_usd` 均为 `0.0310`。

但 README §10 当时仍写「Dress fidelity is still unverified」。**仓库内没有任何对这批输出的
评审结论** → 保真度是否已确认：**未登记**。

## 下一步

1. ~~建 Neon 数据库~~ ✅ **已完成**（2026-10-03）。schema 由部署自动应用。
2. **端到端验证** —— ⚠️ 当前网络无法访问 `*.vercel.app`，需用户在有访问能力的环境确认：
   打开 `https://dressmaker-rouge.vercel.app/`，确认 `/api/health` 返回 `ok:true` 且 `db:true`，
   并真的生成一张图。
3. **dress1 无袖挂脖款**：三轮 prompt 层手段已用尽，剩下结构性方案
   （调换图片顺序 / 预处理参考图弱化衣物区域），尚未开工。
4. **配饰渗透**：dress1 / dress3 领口出现 Rose 默认形象的金色领结，尚未处理。
5. **读 provider 的真实计量**：adapter 尚未读 `usage.input_image_count` / `input_image_type` /
   `output_image_type`；`estimated_cost` 目前只是运营估算
   （¥0.22/张 = 输入 ¥0.02×2 + 输出 ¥0.18，1024×1024 落在 1k 计费档）。
6. **决定 GitHub Pages 工作流的去留**：`.github/workflows/deploy-web.yml` 仍在，
   每次 push 都会往 Pages 发一份没有 API 的前端。迁移完成后建议删除
   （本轮未删，避免在 Vercel 未验证前拆掉退路）。
7. **GA4 埋点仍不产生数据**：Vercel 项目未设 `VITE_GA4_ID`（需在 Vercel 环境变量里配）。
8. 上传内容假定为游戏截图（README 明示 UI 只索取游戏截图，但模型仍可能拒绝或给出差结果）。

## 是否已上线

**已部署上线（单项目），但尚不能生成图片，且当前网络无法验证。**

- **Production URL（唯一入口）：https://dressmaker-rouge.vercel.app**
  - Vercel 项目 `dressmaker`（`prj_1FEUfj463svOURMBTgFNSpgeqRuN`），**root = 仓库根**
  - 前端 `/` 与 API `/api/*` 同源同项目；部署 `READY`，函数数 = 4，前端 `dist/` 已产出
  - ⚠️ **从当前网络不可达**，实测 `http=000`（GFW 阻断 `*.vercel.app`，详见「最近完成」）
- **旧入口（legacy）**：https://tyoutetu.github.io/dressmaker/ —— **实测 HTTP 200**（可访问）。
  但它是 GitHub Pages 静态托管，`*.github.io/api/*` 是 404，**无法生成**；
  且前端已改为默认同源，Pages 上不再有可用 API。
- ✅ **数据库已接入**：Neon 集成注入 `DATABASE_URL`，schema 随部署自动应用
  （构建日志确认 4 张表 + `reserve_generation_quota()` 均已建）
- 端到端能否生成：**仍未验证**（当前网络无法访问该域名，需用户在有访问能力的环境确认）
- 已删除：旧项目 `dressmaker-api`（双项目方案已废弃）

## 已知问题 / 待确认

1. **缺 `DATABASE_URL`**：唯一挡着「能用」的缺口。Neon 库必须由用户在 Vercel 网页创建
   （CLI 的 `storage create` 只支持 blob/global-config，`integration resource` 没有 create）。
2. **`*.vercel.app` 国内不可达**：实测 DNS 污染（本地解析到 Facebook IP 段、
   8.8.8.8 也给出错误 IP）+ SNI 层连接重置 + 浏览器通道超时。
   用户 2026-10-03 明确表示「不打算给国内的人看」，故**暂不挂自定义域名**；
   但需知道：**用户本人自测也需要能访问该域名的手段**。
3. **端到端未验证**：因上一条，agent 无法从本机验证线上是否真能生成。
   已验证的只有：构建成功、函数数 = 4、环境变量就位、部署 READY。
4. **dress1（无袖挂脖）保真度未解决**：三轮 prompt 层手段用尽，剩结构性方案。
5. **配饰渗透**：dress1 / dress3 领口出现 Rose 默认形象的金色领结。
6. **`shared/` 是真·空目录**（`git ls-files shared` 为 0 条，git 不跟踪空目录，
   它根本不在仓库里，只是本地残留）→ 可以直接删。
7. **GitHub Pages 工作流仍会发布**：`.github/workflows/deploy-web.yml` 每次 push 都往 Pages
   发一份没有 API 的前端。本轮**刻意保留**作为退路，Vercel 验证通过后应删除。
8. **GA4 埋点不产生数据**：Vercel 项目未设 `VITE_GA4_ID`，`track()` 静默返回。
9. **`.vercel-token` 是敏感文件**：用户设了 1 天有效期；**用完需删文件 + 在 Vercel 撤销**。

## 敏感信息

- `dressmaker/.vercel-token`（60 字节，权限 0600，**已 gitignore**）——
  Vercel Personal Access Token，用户 2026-10-03 创建时设了 **1 天有效期**。
  **用完需删除本地文件 + 在 https://vercel.com/account/tokens 撤销。**
- `dressmaker/.env`（1688 字节，权限 0600，**已 gitignore**；本轮随重构从 `api/.env` 移到根目录）——
  含真实 `DASHSCOPE_API_KEY`（千问AI平台，`sk-ws-` 开头）

**两者都已被 gitignore，未进入 git。**
另注：该 DASHSCOPE key 曾于 2026-10-02 出现在 agent 对话记录中，已建议用户轮换；
Vercel token 同样于 2026-10-03 出现在对话记录中，故「用完即撤」不是可选项。

## Last Updated

2026-10-03（部署架构迁移完成：单 Vercel 项目 `dressmaker` 上线，
生产域名 `dressmaker-rouge.vercel.app`；旧 `dressmaker-api` 项目已删；
函数数由 37 降至 4；151 项测试通过；仍缺 `DATABASE_URL`，且当前网络无法验证端到端）
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
- 前端：Vite + React 19 静态站点，部署到 GitHub Pages

仓库：`git@github.com:tyoutetu/dressmaker.git`

### 子目录分工

| 目录 | 分工 |
|---|---|
| `api/` | Vercel functions 及函数所需的一切 |
| `api/api/` | HTTP handlers：`generate.ts` / `quota.ts` / `feedback.ts` / `health.ts` |
| `api/lib/` | `npcs` / `quota` / `ip` / `db` / `providers` / `validation` / `prompt` / `output` / `body` / `env` / `config` / `errors` / `npcAssets` |
| `api/assets/npcs/` | 发给模型的顾客参考图（`rose.webp`、`priya.webp`） |
| `api/sql/schema.sql` | Postgres schema + 额度预留函数 |
| `api/scripts/` | 本地 mock、db 初始化、付费质量 spike（`mock-server.ts` / `db-init.ts` / `spike.ts`） |
| `api/tests/` | handler、配额 SQL、provider、mock 测试（14 个 `*.test.ts`） |
| `web/` | 静态前端（Vite + React），部署到 GitHub Pages |
| `web/public/npcs/` | 顾客选择卡片上显示的同一批立绘 |
| `web/src/lib/qr.ts` | 无依赖 QR 编码器（分享卡用，byte 模式、level M、版本 1–10） |
| `web/src/lib/shareCard.ts` | canvas 合成可分享 PNG |
| `shared/` | ⚠️ **空目录**。`git ls-files shared` 无输出，README 未提及，全仓库无引用 → **用途未登记** |
| `spike-out/` | 付费 spike 输出（已 gitignore） |
| `test-dresses/` | 付费 spike 的本地输入素材（已 gitignore） |

`api/lib/npcs.ts` 是顾客列表的唯一事实来源，web 构建再导出它。

## 最近完成

倒序。**建档时未运行任何构建/测试**，故区分「建档实测」与「仓库内既有证据」。

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

1. **建 Neon 数据库**（只能网页做）→ Vercel 控制台 → 项目 `dressmaker-api` →
   Storage → Create Database → Neon（免费档）。建完 Vercel 自动注入 `DATABASE_URL`，
   然后跑 `npm run db:init` 建表并重新部署。
2. **接上前后端**：设 GitHub 仓库变量 `VITE_API_BASE=https://dressmaker-api.vercel.app`；
   设 Vercel `ALLOWED_ORIGINS=https://tyoutetu.github.io`（若前端也迁到 Vercel 则改成对应源）。
3. **端到端验证** —— ⚠️ 当前网络无法访问 `*.vercel.app`，需在有访问能力的环境确认。
4. **dress1 无袖挂脖款**：三轮 prompt 层手段已用尽，剩下结构性方案
   （调换图片顺序 / 预处理参考图弱化衣物区域），尚未开工。
5. **读取 provider 的真实计量**：adapter 尚未读 `usage.input_image_count` / `input_image_type` /
   `output_image_type`；`estimated_cost` 目前只是运营估算
   （¥0.22/张 = 输入 ¥0.02×2 + 输出 ¥0.18，1024×1024 落在 1k 计费档）。
6. 上传内容假定为游戏截图（README 明示 UI 只索取游戏截图，但模型仍可能拒绝或给出差结果）。

## 是否已上线

**部分上线：前端已上线且可访问；API 已部署但当前网络不可达，且尚未接数据库。**

- **前端 Production URL：https://tyoutetu.github.io/dressmaker/**
  - **2026-10-03 复测：HTTP 200**（浏览器通道同样 200），`<title>` 与 README 一致
- **API Production URL：https://dressmaker-api.vercel.app**（2026-10-03 新建）
  - 部署状态 **READY**（Vercel API 查询），构建日志正常
  - ⚠️ **从当前网络不可达**（GFW 阻断 `*.vercel.app`，详见「最近完成」）
  - ⚠️ **无 `DATABASE_URL`** → 即使可达，`/api/generate` 与 `/api/quota` 也会 fail-closed 返回 503
  - **端到端能否生成：未验证（当前网络无法验证）**
- 两处仍未接上：GitHub 仓库变量 `VITE_API_BASE` 未设置（前端仍指向空 base）；
  Vercel API 的 `ALLOWED_ORIGINS` 未设置
- 使用须知（README §6）：GitHub Pages 不能保存 API key、数据库 URL 或配额，所有密钥都留在 Vercel

## 已知问题 / 待确认

1. **线上前端仍跑不通**：线上 JS 的 API base 是空串，`/api/*` 在 Pages 上是 404 ——
   站点看起来上线了，实际无法生成。**修法已明确**：设 GitHub 仓库变量
   `VITE_API_BASE=https://dressmaker-api.vercel.app` 重跑 workflow（`ALLOWED_ORIGINS`
   也要同步设成 Pages 源）。**但设完之后端到端能否跑通，在当前网络无法验证。**
2. **`*.vercel.app` 国内不可达**：若要让国内可访问（或让用户本人无须 VPN 就能自测），
   必须给 API 挂自定义域名。用户 2026-10-03 明确表示「不打算给国内的人看」，
   故此项**暂不处理**，但需知道：用户本人自测也需要能访问该域名的手段。
3. **dress1（无袖挂脖）保真度未解决**：三轮 prompt 层手段用尽，剩下的是结构性方案
   （调换图片顺序 / 预处理参考图弱化衣物区域），尚未开工。
4. **配饰渗透**：dress1 / dress3 领口出现 Rose 默认形象的金色领结，尚未处理。
5. **`shared/` 是真·空目录**（2026-10-03 核实：`git ls-files shared` 为 0 条，
   git 不跟踪空目录，所以它根本不在仓库里，只是本地残留）→ 可以直接删。
6. **GA4 埋点已上线但不产生数据**：GitHub 仓库未设 `VITE_GA4_ID`，`track()` 静默返回。
   要生效需在仓库 Variables 里配置并重跑 workflow。
7. `.gitignore` 有 6 行未提交改动（新增 `.vercel-token` 忽略规则）；`PROJECT_STATUS.md`
   本身也未加入 git。两者已于 2026-10-03 一并提交，见下次更新记录。
8. **`.vercel-token` 是敏感文件**：60 字节、权限 0600、已 gitignore。用户 2026-10-03
   创建时设了 1 天有效期；**用完需删除本地文件并在 Vercel 撤销该 token**。

## 敏感信息

- `dressmaker/.vercel-token`（60 字节，权限 0600，**已 gitignore**）——
  Vercel Personal Access Token，用户 2026-10-03 创建时设了 **1 天有效期**。
  **用完需删除本地文件 + 在 https://vercel.com/account/tokens 撤销。**
- `dressmaker/api/.env`（1688 字节，权限 0600，**已 gitignore**）——
  含真实 `DASHSCOPE_API_KEY`（千问AI平台，`sk-ws-` 开头）

**两者都已被 gitignore，未进入 git。**
另注：该 DASHSCOPE key 曾于 2026-10-02 出现在 agent 对话记录中，已建议用户轮换；
Vercel token 同样于 2026-10-03 出现在对话记录中，故「用完即撤」不是可选项。

## Last Updated

2026-10-03（补档：Vercel API 项目已建并部署 READY；spike 三轮保真度结论 4/5；
`*.vercel.app` 国内不可达已实测确认；`shared/` 核实为空目录；.gitignore 与本文档已提交）

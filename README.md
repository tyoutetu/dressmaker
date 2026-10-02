# Dressmaker dress preview — unofficial beta

Upload a screenshot of a dress you made in *Dressmaker*, pick a customer, and
generate an AI preview of that customer wearing your dress.

Only the two customers with real artwork ship enabled: **Rose** and **Priya**.
Any other name in the UI would be a placeholder pretending to be a character, so
the tool does not show one.

> **Status: unofficial, fan-made beta.** *Dressmaker*, its characters and its art
> belong to their respective owners. Previews are experimental and will not match
> the in-game result. This app does not save your uploaded screenshot file; the
> screenshot is sent to the configured AI provider to generate the preview, and
> that provider handles it under its own policy.

```
.
├── api/                 # Vercel functions + everything the functions need
│   ├── api/             #   HTTP handlers: generate / quota / feedback / health
│   ├── lib/             #   npcs, quota, ip, db, providers, validation, prompt
│   ├── assets/npcs/     #   customer reference art sent to the model
│   ├── sql/schema.sql   #   Postgres schema + quota reservation function
│   ├── scripts/         #   local mock, db init, paid-quality spike
│   └── tests/           #   handler, quota-SQL, provider and mock tests
└── web/                 # static frontend (Vite + React) deployed to GitHub Pages
    ├── public/npcs/     #   the same portraits, shown on the picker cards
    └── src/
        ├── lib/qr.ts        #   dependency-free QR encoder for the share card
        └── lib/shareCard.ts #   canvas composition of the shareable PNG
```

`api/lib/npcs.ts` is the single source of truth for the customer list; the web
build re-exports it.

---

## 1. Cost control (read this first)

Every generation is a paid API call, so the ceiling is enforced by the server,
never by the browser.

| Rule | Implementation |
|---|---|
| Per-network limit | `USER_DAILY_GENERATION_LIMIT` paid attempts per UTC day, default **3** and hard-capped: values above 3 are rejected and the app fails closed. `0` disables paid generation for every network |
| Global limit | `GLOBAL_DAILY_GENERATION_LIMIT` (default **100**) paid attempts per UTC day; **0 disables paid generation entirely** |
| Identity | HMAC-SHA256 of the client IP with `IP_HASH_SECRET`. The raw IP is never stored or logged, and the browser's `client_id` is analytics only — clearing storage does not reset anything |
| Trusted source | `x-vercel-forwarded-for`, **and only when `VERCEL=1`**. `x-forwarded-for`, `x-real-ip`, `forwarded` and query parameters are client-controlled and are ignored |
| Missing/!valid identity, missing secret, missing database, malformed limit, `USER_DAILY_GENERATION_LIMIT > 3` | **fail closed** (503) with nothing charged |
| When it is charged | Validation and configuration run *first*; the reservation is atomic and happens *before* the provider call. Once the provider is dispatched the attempt stays counted — there are no refunds, so a retry can never quietly buy a second paid call |
| Outcome-unknown | A client timeout, dropped connection or non-JSON response is reported to the visitor as **outcome unknown**: the attempt may already have been counted, so the counter is refreshed after every attempt and the copy never claims it was free |
| Retries | None, anywhere: the OpenAI client runs with `maxRetries: 0`, the Qwen adapter performs a single `fetch`, and nothing retries a failed generation automatically |
| Outputs | `n: 1` is set by the server on every request |
| Reset | 00:00 UTC, shown in the UI in the visitor's own local time |

Reservations are made by `reserve_generation_quota(...)` in
[`api/sql/schema.sql`](api/sql/schema.sql): one Postgres function takes a
per-day advisory lock and moves the per-network and global counters together,
so concurrent requests, cold starts and multiple function instances cannot
overshoot either ceiling. It runs as a single statement through Neon's HTTP
driver, so it is one atomic round trip.

Shared networks share the quota — a household, dorm or café counts as one — and
the UI says so.

### The trusted-IP requirement

`x-vercel-forwarded-for` is written by the Vercel platform. Outside Vercel (local
development, tests) there is no such header, so the quota fails closed unless you
opt into loopback mode:

```bash
ALLOW_LOCAL_QUOTA_MODE=true   # local only; ignored whenever VERCEL=1
```

That mode keys every local request to the loopback identity, which is exactly
what you want for a local demo and useless as a production bypass: on Vercel the
same setting is ignored and a missing header still returns 503.

You also need a secret to hash with:

```bash
IP_HASH_SECRET="$(openssl rand -hex 32)"   # >= 16 characters, required on Vercel
```

---

## 2. Prerequisites

1. A **Vercel** project for the API.
2. A **Neon Postgres** database (free tier is fine) — quota counters and feedback.
3. A **Qwen API key** for the default provider — either 千问AI平台
   (QwenCloud, keys start with `sk-ws-`) or 阿里云百炼 / Alibaba Cloud Model
   Studio (keys start with `sk-`). The two accounts are separate and the keys are
   not interchangeable; see [§5](#5-provider-qwen-image-default). A Gemini /
   OpenAI key works too if you switch providers.
4. A **GitHub repo** — the frontend deploys to GitHub Pages.
5. A **GA4 measurement ID** — optional; the site is fully functional without it.

---

## 3. Database

```bash
cd api
cp .env.example .env      # set DATABASE_URL
npm ci
npm run db:init           # applies sql/schema.sql (idempotent)
```

Tables: `generations` (metadata only — no screenshots), `feedback`,
`usage_daily`, `global_usage_daily`, plus the `reserve_generation_quota()`
function.

> **Upgrading from the older demo schema:** the quota table used to be keyed by a
> browser id. `schema.sql` renames that table to `usage_daily_legacy_<timestamp>`
> (idempotently) before creating the IP-keyed table, so the old metadata is kept
> instead of destroyed. Browser ids are never copied into IP hashes —
> `usage_daily` simply starts empty. `schema.sql` is safe to apply repeatedly.

---

## 4. Deploy the API on Vercel

Set **Root Directory = `api`** and Framework Preset **Other**.

The root directory must be `api` for two reasons: files directly inside `api/`
become HTTP routes (so `lib/`, `scripts/` and `assets/` must stay outside it),
and the customer config lives in `api/lib/npcs.ts` so the function depends on
nothing outside its own root — Vercel does not upload files from outside the
Root Directory. Reference art is bundled explicitly:

```json
{
  "functions": {
    "api/**/*.ts": { "maxDuration": 300, "includeFiles": "assets/npcs/**" }
  }
}
```

Handlers use Vercel's documented Web-standard shape for the Node.js runtime:
each file exports a named route function (`(request: Request) => Response`) and a
default export of `{ fetch: route }`. Tests call the named route directly. Bodies
are bounded before parsing (an early `Content-Length` check plus a streaming byte
ceiling), so an oversized multipart upload is refused before it is buffered.

Environment variables (Production and Preview), matching
[`api/.env.example`](api/.env.example):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `IP_HASH_SECRET` | random string, ≥ 16 characters |
| `AI_PROVIDER` | `qwen` (default), `gemini` or `openai` |
| `DASHSCOPE_API_KEY` | required for the Qwen provider (the variable name is the platform's, on both) |
| `QWEN_BASE_URL` | default `https://maas.qianwenaiapi.com` (千问AI平台). For 阿里云百炼 use the **workspace-scoped** host `https://<workspace>.cn-beijing.maas.aliyuncs.com` — plain `https://dashscope.aliyuncs.com` does **not** serve the images route (verified: it returns 404, while it answers `/compatible-mode/v1/chat/completions` normally) |
| `QWEN_IMAGE_MODEL` | default `qwen-image-3.0` |
| `USER_DAILY_GENERATION_LIMIT` | `3` (may be lowered or set to `0`; values above 3 are rejected) |
| `GLOBAL_DAILY_GENERATION_LIMIT` | `100` (`0` = kill switch) |
| `ALLOWED_ORIGINS` | your Pages origin, comma-separated, no trailing slash |

Optional: `QWEN_PROMPT_EXTEND`, `QWEN_ENABLE_THINKING` (both default to
`false` — see [§5](#5-provider-qwen-image-default) for why), `GEMINI_API_KEY`,
`GEMINI_IMAGE_MODEL`, `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`,
`OPENAI_IMAGE_QUALITY`, `MAX_UPLOAD_BYTES`, `MAX_IMAGE_DIMENSION`,
`MAX_OUTPUT_BYTES`, `GENERATION_TIMEOUT_MS`, and the operator-provided
`ESTIMATED_COST_*_USD` cost estimates (decimals such as `0.03` are preserved;
leave them unset and the estimate is recorded as NULL rather than invented).

Verify the deployment:

```bash
curl https://<api>.vercel.app/api/health
# {"ok":true,"provider":"qwen","providerConfigured":true,"db":true,"quotaConfigured":true, ...}
```

`/api/health` returns booleans only — no configuration values, no secrets.

### Runtime requirements

| Setting | Value | Why |
|---|---|---|
| Vercel `maxDuration` | 300 s | Image generation can take minutes, so the function needs a generous ceiling |
| `GENERATION_TIMEOUT_MS` | 240000 | The server's own ceiling; must be below `maxDuration` |
| Client timeout | 270000 | Deliberately longer than the server's, so a slow success is not cut off in the browser |
| Body / response size | 4.5 MB | A Vercel platform limit. Uploads are re-encoded client-side to a ≤2048 px JPEG and server-side capped by `MAX_UPLOAD_BYTES`; results are normalized to a bounded PNG (`MAX_OUTPUT_BYTES`, default 2.6 MB) so the base64 payload stays inside the limit |

If your Vercel plan cannot run a function for 300 seconds, lower both
`maxDuration` and `GENERATION_TIMEOUT_MS` together and expect more timeouts.

---

## 5. Provider: Qwen Image (default)

The default adapter calls the OpenAI-compatible JSON endpoint:

```
POST {QWEN_BASE_URL}/compatible-mode/v1/images/generations
{
  "model": "qwen-image-3.0",
  "prompt": "<shared prompt + per-customer notes>",
  "image": ["data:image/png;base64,<customer reference>",
            "data:image/jpeg;base64,<your dress screenshot>"],
  "n": 1,
  "size": "1024x1024",
  "prompt_extend": false,
  "enable_thinking": false
}
```

`prompt_extend` and `enable_thinking` are written out on every request *because
the platform turns both on when the fields are absent*, and neither default suits
this product:

- `prompt_extend: true` lets the model **rewrite the prompt**. Ours is almost
  entirely negative constraints — "do not redesign or reinterpret the dress",
  "add no decoration that is not visible" — and a rewriter can soften exactly the
  rules that keep the output faithful to the player's screenshot.
- `enable_thinking: true` *"increases generation time"*, and the attempt is
  reserved before the provider call and never refunded, so a request that runs
  past `GENERATION_TIMEOUT_MS` burns a visitor's daily allowance for nothing.

Set `QWEN_PROMPT_EXTEND=true` / `QWEN_ENABLE_THINKING=true` to opt back in.
Thinking mode only takes effect while prompt extend is on, so asking for thinking
with rewriting disabled would be silently ignored — a deployment in that state
fails closed with a 503 instead, before the quota is reserved, so it costs nothing.

Billing is per input image **plus** per output image, and 1024×1024 keeps both
sides in the cheaper `qima_*_1k` tier, so a two-reference generation is billed as
2 inputs + 1 output (¥0.02 × 2 + ¥0.18 = ¥0.22 per preview on the Beijing price
list).

### Two platforms, one contract

`QWEN_BASE_URL` selects the platform. Both serve the request shape above and both
are on the endpoint allowlist, so switching is one variable — but **the accounts
and API keys are separate and cannot be mixed**:

| Platform | Base URL | Key prefix | Where to get the key |
|---|---|---|---|
| 千问AI平台 (QwenCloud) — default | `https://maas.qianwenaiapi.com` | `sk-ws-` | `platform.qianwenai.com/home/api-keys` |
| 阿里云百炼 (Model Studio) | `https://<workspace>.cn-beijing.maas.aliyuncs.com` | `sk-` | `bailian.console.aliyun.com` |

Both are Alibaba Cloud products — 千问AI平台 is the newer front-end (launched as
"千问云"), and its accounts *are* Alibaba Cloud accounts — and both serve the same
gateway, so the request shape above is identical on either. Only the hostname and
the console that issued the key differ. Note that the images route is **not** on
plain `dashscope.aliyuncs.com`: that host answers chat completions but returns 404
for `/compatible-mode/v1/images/generations`, so use the workspace-scoped host for
百炼.

A key from one platform against the other's host fails with a credential error,
so a misconfiguration costs nothing rather than billing the wrong account.

This is *not* the standard OpenAI multipart image-edit call. The result comes
back as `data[0].url`; the adapter downloads that URL without an Authorization
header, only from an `*.aliyuncs.com` / `*.aliyun.com` / `*.alicdn.com` host —
over https, with a bounded stream, and then re-encodes the bytes as PNG. The
endpoint itself must be an `https` host on the allowlist (`.qianwenaiapi.com` or
`.aliyuncs.com`); `QWEN_BASE_URL` cannot be pointed at an arbitrary server, and no
client input can override the model, endpoint or key.

`gemini` and `openai` remain available behind the same interface
(`api/lib/provider.ts`) by setting `AI_PROVIDER`.

---

## 6. Deploy the frontend to GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Add repository **variables**: `VITE_API_BASE` = your Vercel API URL,
   `VITE_SITE_URL` = the public address visitors reach the site on (needed for
   sharing — see below), and optionally `VITE_GA4_ID`.
3. Push to `main`. `.github/workflows/deploy-web.yml` runs `npm ci` and builds
   `web/` with `--base=/<repo>/`.
4. Point `ALLOWED_ORIGINS` on Vercel at the final Pages origin.

Asset paths (including the customer portraits) are resolved through Vite's
`BASE_URL`, so the site works both at `https://<user>.github.io/<repo>/` and at a
custom domain. For a user/org site (`<user>.github.io`) or a custom domain, set
the repository variable `VITE_BASE_PATH=/`.

GitHub Pages only serves static files: it cannot hold the API key, the database
URL or the quota. The static site is safe to publish; every secret stays on
Vercel.

### The share card

After a preview is generated, the result page offers a **Share** control that
produces one 1080×1350 PNG carrying the preview, the site address and a QR code
pointing at it — the whole point being that someone who sees the image can scan
it and make their own preview without being told a URL.

- The card is composed **in the visitor's browser**, on a canvas. A share costs
  no server work, no upload and no provider call.
- The QR code is encoded by `web/src/lib/qr.ts`, a dependency-free QR encoder
  (byte mode, level M, versions 1–10). The frontend ships exactly two runtime
  packages, and a QR library would have been the largest thing in the bundle for
  a single short, same-origin URL. It adds ~3.9 kB gzipped.
- `VITE_SITE_URL` is what the QR encodes, verbatim — path included, so a Pages
  project site's `/<repo>/` works, while query and hash are stripped so the code
  never carries someone's campaign parameters. **When it is unset or unusable the
  share control does not render at all**, rather than printing a code that leads
  nowhere. It has to be the real public address, so set it before sharing the
  site with anyone.
- On a phone the composed file goes to the system share sheet; on a desktop,
  where there is no share sheet for files, the same control is a real
  `<a download>` link and the browser's own click starts the download.
- The QR's light margin is computed in **modules, not pixels** (four modules, as
  the spec requires). A fixed pixel margin is wrong at both ends of the version
  range: a version 1 code is 21 modules and a version 10 code is 57, so at a
  264 px block the margin has to be 36 px and 16 px respectively.

---

## 7. Local development

### Local mock (recommended for review)

```bash
cd api && npm ci && npm run mock        # http://localhost:8787
cd web && VITE_API_BASE=http://localhost:8787 npm run dev
```

The mock implements the same routes and the same quota contract as production,
but it calls no model: every preview is a drawn placeholder labelled
`LOCAL MOCK PREVIEW`, responses carry `mock: true`, and the UI shows a "Local
mock running" banner. Useful env: `MOCK_USER_DAILY_LIMIT`,
`MOCK_GLOBAL_DAILY_LIMIT`, `MOCK_PORT`, and `MOCK_FAIL=timeout|provider` to
review the error states.

### Real functions locally

```bash
cd api && cp .env.example .env    # fill in DATABASE_URL, IP_HASH_SECRET, DASHSCOPE_API_KEY
npx vercel dev                    # http://localhost:3000
cd web && VITE_API_BASE=http://localhost:3000 npm run dev
```

Set `ALLOW_LOCAL_QUOTA_MODE=true` in `api/.env` so the local quota can resolve an
identity. Local origins (`localhost:5173/4173`) are pre-allowlisted for CORS.

---

## 8. Tests

```bash
cd api
npm run typecheck
npm test

cd ../web
npm run typecheck
npm run build
npm run build -- --base=/dressmaker/    # GitHub Pages sub-path build
```

`npm test` runs the real handlers and the real quota SQL:

| Area | What is covered |
|---|---|
| Quota SQL (embedded Postgres via PGlite) | 20 concurrent reservations yield exactly 3; global ceiling; next-day rollover; a changed browser id from the same network; IPv6 spellings of one host, including the full IPv4-mapped form; malformed ports/brackets/zones rejected; zero limits; unusable identity; an old browser-id schema is renamed aside (not dropped) and the schema can be applied twice |
| Handlers | validation and config failures charge nothing and never reach the provider; a `USER_DAILY_GENERATION_LIMIT` above the product maximum of 3 is rejected; exactly 3 paid attempts then 429 with the reset instant; a dispatched failure stays counted with no refund; spoofed `x-forwarded-for`/`x-real-ip` cannot widen the quota; an oversized body is refused before validation; database outage fails closed; `/api/quota` is read-only and reports a spent global budget without blaming the visitor; `/api/health` leaks no values |
| Provider | both images are sent as data URLs with `n: 1`; endpoint and result-URL validation; no auth header on the result host; redirects; rate-limit, moderation and credential mapping; timeout; oversized and non-image results |
| Output / client | portrait results are bounded on their long edge; `null`/array/primitive provider JSON never throws; client timeout and lost responses are recorded as an unknown outcome (never "not charged"); the result download decodes to a Blob exposed through a real `<a download>` object URL, released when the result changes or the section unmounts (Strict Mode's double effect leaves one live URL) |
| QR / share card | version selection grows with the payload and refuses an over-long link instead of truncating; the matrix is square, sized by its version, deterministic, and carries all three finder patterns; alignment centres match the standard at versions 2, 7 and 10; site URLs keep their sub-path but drop query/hash; non-http and relative addresses are refused rather than encoded; the quiet zone is four *modules* at versions 21 through 57, which a fixed pixel margin cannot satisfy; the text column never runs under the QR block |
| Local mock | same routes, same 3-per-day contract, same error shapes, `mock: true` |

The share card's rendered output is verified out of band against an independent
decoder (Chromium's `BarcodeDetector`): a card composed through the real UI is
decoded back to the exact `VITE_SITE_URL` it was built from. Unit tests alone
cannot prove a QR scans, which is the one failure the feature cannot survive.

### Paid visual-quality spike (not run in CI)

```bash
cd api
npm run spike -- --npc rose ../test-dresses/dress1.png ../test-dresses/dress2.png
# → ../spike-out/ with a results.csv of latency and estimated cost
```

Every image it renders is billed, so run it deliberately.

---

## 9. Data and analytics

- **Neon:** `generations` (provider, model, latency, the operator-provided
  estimated cost — NULL when unset — error type, whether the attempt was
  counted), `feedback` (rating + optional 500-character note),
  `usage_daily` / `global_usage_daily` (HMAC hashes only).
- **GA4 (optional):** `tool_view`, `npc_selected`, `image_upload_started`,
  `image_upload_success`, `generate_clicked`, `generation_success`,
  `generation_failed`, `limit_reached`, `result_downloaded`, `regenerate_clicked`,
  `switch_npc_after_result`, `result_feedback`, `feedback_submitted`,
  `share_clicked`, `share_completed`, `share_failed` — with
  low-cardinality parameters only. Images, file names and feedback text are never
  sent to GA4.

  The share events carry `method` (`sheet` when the phone's share sheet opened,
  `download` when the desktop download link was used) and, on failure,
  `error_type` (`cancelled` when the visitor dismissed the share sheet,
  `rejected` when the browser refused the share). `share_clicked` is the
  denominator for the funnel: `share_completed / share_clicked` is the share
  success rate, and the point of the whole feature is that a shared image brings
  a new visitor back through the QR code.

## 10. Known limitations

- **Dress fidelity is still unverified.** The live path is now proven end to end
  — a real `qwen-image-3.0` call on 千问AI平台 returned a 1024×1024 PNG in 11.5 s,
  preserving the customer's face, hair, glasses, art style and pose — but that run
  passed the customer's own portrait as the "dress" input, so it says nothing
  about whether a *dress screenshot* is reproduced faithfully. That is the one
  claim the product rests on, and it needs the spike above run against real dress
  screenshots. Worth watching: given only a portrait the model *embellished* the
  outfit rather than copying it, which is exactly the behaviour the prompt's
  "do not redesign or reinterpret the dress" clause exists to suppress.
- **Latency, measured.** One live `qwen-image-3.0` generation on
  千问AI平台 took **11.5 s** end to end with `prompt_extend` and
  `enable_thinking` both off, well inside the 240 s provider ceiling and the
  300 s function limit — so the timeout risk that motivated those two defaults
  is not currently binding. Re-measure if thinking mode is ever switched on,
  since the provider documents it as the thing that "increases generation time".
- **Recorded cost is an operator estimate, not measured spend.** The provider
  returns exact metering (`usage.input_image_count`, `input_image_type`,
  `output_image_type`), but the adapter does not read it yet: `estimated_cost` is
  only as good as `ESTIMATED_COST_QWEN_PER_IMAGE_USD`, and is NULL when unset.
  Note the platform bills the two input images as well as the output.
- The public copy says the app itself does not save the uploaded screenshot file
  and that the screenshot is sent to the AI provider to generate the preview;
  the provider's own policy governs its handling. The provider is named in this
  README, not on the page.
- Uploads are assumed to be screenshots. The UI asks for game screenshots only,
  and the prompt constrains output to a single character illustration, but a
  model may still refuse an image or produce a poor result.

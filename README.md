# pi-mimo-search

Web search tool for [Pi](https://pi.dev) backed by the **Xiaomi MiMo Web Search plugin** — pay-as-you-go, with structured citations and per-call cost reporting.

Pi has no built-in web search. MiMo offers one, but only as a server-side plugin on its OpenAI-compatible Chat Completions API (`tools: [{ "type": "web_search" }]`). This package exposes it to Pi as a regular agent tool:

```
web_search(query="...")
  -> answer + numbered source citations
  -> [search cost: CNY 0.0160 plugin fee + $0.00020 tokens = $0.00243 total]
```

## Features

- **Works with any main model** — the search is a side-call to MiMo's PAYG endpoint; your conversation can stay on a Token Plan model, Anthropic, anything.
- **Structured citations** — `url_citation` annotations are parsed and returned (title, site, publish time, summary) as tool `structuredContent`, not dropped.
- **Cost visibility** — every call reports the plugin fee (CNY) and token cost (USD) it just incurred; totals are folded into Pi's session usage so you can reconcile against the MiMo console.
- **Cost controls** — `max_keyword: 1` default (each keyword = one billed plugin invocation), capped `limit`, intent-recognition mode by default (`force_search` off), `mimo-v2.6-flash` with thinking disabled for the side-call.
- **Actionable errors** — 401 (key), 402 (balance), the `webSearchEnabled` gate, and 429 each come back with the exact fix.

## Quick Start

Five steps from zero to a working search. Steps 1-2 happen in the [MiMo console](https://platform.xiaomimimo.com/), steps 3-5 in your terminal.

**1. Create a PAYG API key**
Go to [API Keys](https://platform.xiaomimimo.com/#/console/api-keys) and create a key. It must be the pay-as-you-go key format **`sk-...`** — a Token Plan key (`tp-...`) will not work, web search is PAYG-only.

**2. Top up balance and activate the plugin**

- Top up at [Account Balance](https://platform.xiaomimimo.com/#/console/balance) — CNY 10 is plenty for ~600 searches (see [billing](#how-billing-works)).
- Activate the **Web Search Plugin** at [Plugin Management](https://platform.xiaomimimo.com/#/console/plugin).
- Wait ~5 minutes after toggling — the switch has a server-side cache.

**3. Give Pi the key**

Start Pi and run inside the session:

```
/login xiaomi
```

Choose the login prompt and paste your `sk-...` key. It is stored in `~/.pi/agent/auth.json` (mode 600); the extension never reads it directly.

Alternative for headless/CI setups — environment variable (exact name matters), in e.g. `~/.zshrc`:

```bash
export XIAOMI_API_KEY="sk-..."
```

**4. Install the package**

```bash
pi install npm:pi-mimo-search     # or: pi install git:github.com/rioliu/pi-mimo-search
```

Restart Pi (or run `/reload`).

**5. Verify**

First confirm the tool is registered — in a shell:

```bash
pi --print "Reply with exactly: TOOLS: <comma-separated list of your tool names>"
# expect web_search in the output
```

Then do a live search (~CNY 0.02) — open Pi and ask anything that needs current information:

```
> 武汉今天适合户外跑步吗？帮我搜一下天气
```

Abridged, your transcript shows the tool call and its result:

```
web_search(query="武汉今天天气")
  根据搜索结果，武汉今天天气晴朗，当前温度25度，湿度38%…

  Sources:
  1. 武汉市天气 空气质量 降水 预警 - https://www.qweather.com/weather/wuhan-101200101.html (和风天气, 2026-10-07)

  [search cost: CNY 0.0160 plugin fee + $0.00025 tokens = $0.00247 total]
```

If the answer and cost line appear, you are done. If anything failed, jump to [Troubleshooting](#troubleshooting).

## Usage

Just ask the model to search, or let it decide — the tool description tells it when search is appropriate. Model-driven intent recognition is the default: it searches for live information (news, prices, weather, releases) and skips questions it can answer from memory, so idle conversation costs nothing.

Force a search when the model is too confident:

```
> web_search: latest pi coding agent release notes, force=true
```

### Parameters

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | — | Search query in the user's language |
| `force` | bool | `false` | `force_search`: search even if the model thinks it knows the answer |
| `maxKeyword` | int 1-3 | `1` | Concurrent keywords per round — **each is one billed invocation** |
| `results` | int 1-5 | `2` | Pages returned/injected — more pages = more input tokens |

### Programmatic results

The result's `structuredContent` (declared via `outputSchema`) carries:

```jsonc
{
  "answer": "...",
  "citations": [{ "url": "...", "title": "...", "siteName": "...", "publishTime": "...", "summary": "..." }],
  "usage": { "promptTokens": 954, "completionTokens": 400, "reasoningTokens": 0,
             "pluginInvocations": 1, "pages": 1 },
  "cost": { "tokensUsd": 0.00025, "pluginFeeCny": 0.016, "totalUsd": 0.00247 }
}
```

Available to codemode scripts and other programmatic callers; the model-facing `content` is the answer plus source list plus the one-line cost summary.

## How billing works

MiMo charges the plugin **separately from tokens and separately from Token Plan quota**:

- **Plugin fee**: CNY 16 / 1,000 invocations (CN region; USD 5 / 1,000 overseas). One search round fires up to `max_keyword` concurrent keyword searches = that many invocations.
- **Tokens**: search content is injected into the side-call prompt — flash-model prices, charged to your PAYG balance.

Typical call: `max_keyword: 1` → **CNY 0.016 + a few hundred flash tokens ≈ CNY 0.02**. CNY 50 ≈ 3,000+ searches.

The tool prints its own cost line per call and returns the same numbers structurally, so session totals stay reconcilable with the [Billing console](https://platform.xiaomimimo.com/#/console/usage).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `web_search` not in the tool list | package missing or disabled | `pi list` shows the package; `pi config` to enable it; restart Pi |
| `401 ... login xiaomi or set XIAOMI_API_KEY` | no key or wrong key | `/login xiaomi` with the `sk-...` key, or export `XIAOMI_API_KEY` (exact name) |
| `402 Insufficient PAYG balance` | balance empty | top up at [Account Balance](https://platform.xiaomimimo.com/#/console/balance) |
| `400 ... webSearchEnabled is false` | plugin not activated, or toggled < 5 min ago | activate at [Plugin Management](https://platform.xiaomimimo.com/#/console/plugin), wait 5 minutes |
| `429` rate limit | too many requests | retry with backoff |
| Model answers without searching | intent mode said "not needed" | ask again with `force: true` |
| `(no sources returned)` | search answered without citations | usually fine; try a more specific query |
| Tool times out | search + generation over 90 s | narrow the query |

## Uninstall

```bash
pi remove npm:pi-mimo-search      # or the git: source you installed
```

## Architecture

```
Pi session                          MiMo
  main conversation  ────────────>  your normal provider (Token Plan, Claude, ...)
  web_search tool    ────────────>  api.xiaomimimo.com/v1  (PAYG balance)
                                     model: mimo-v2.6-flash (thinking off)
                                     tools: [{type: web_search, max_keyword: 1, ...}]
                                     -> answer + annotations + web_search_usage
```

Auth resolution uses Pi's built-in `xiaomi` provider: stored `/login` credential first, `XIAOMI_API_KEY` env fallback. The extension itself never reads key material.

## FAQ

**Why not inject `web_search` into every request (native mode)?**
That works when your *main* model is MiMo PAYG — see [jianjye/pi-mimo-web-search](https://github.com/jianjye/pi-mimo-web-search) for that approach. A side-call tool differs: it works with any main provider (including Token Plan models, which MiMo gates off from search), keeps structured citations instead of losing them to Pi's stream normalization, and makes each search's cost explicit. The two styles are complementary.

**Token Plan: `web search tool found in the request body, but webSearchEnabled is false`?**
Web search is PAYG-only. The flag stays off on `token-plan-*` endpoints regardless of plugin activation — verified empirically. Use a `sk-` key on `api.xiaomimimo.com` (this tool does exactly that).

**Can I change the search model or FX rate?**
Token rates and the CNY→USD conversion live in `COST` in [`extensions/search.ts`](extensions/search.ts); the model id is the `MODEL` constant.

## Development

```bash
git clone https://github.com/rioliu/pi-mimo-search
cd pi-mimo-search
npm test          # 12 unit tests, plain node (no deps), fixture from a real API response
pi install ./pi-mimo-search   # load from the checkout while iterating
```

Layout:

```
extensions/index.ts    # tool registration, auth, fetch, result assembly
extensions/search.ts   # pure logic: payload, parser, cost math, error mapping (unit-tested)
test/search.test.ts
```

## License

MIT

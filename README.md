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

## Requirements

1. **MiMo PAYG API key** (`sk-...`) — from the [API Keys console](https://platform.xiaomimimo.com/#/console/api-keys), with a topped-up [balance](https://platform.xiaomimimo.com/#/console/balance). Web search bills against balance; Token Plan keys are rejected (see [FAQ](#faq)).
2. **Web Search plugin activated** — [Console → Plugin Management](https://platform.xiaomimimo.com/#/console/plugin). Note the ~5 minute cache after toggling.
3. **Pi authenticates the `xiaomi` provider** (Pi's built-in PAYG provider):

```bash
/login xiaomi          # paste your sk-... key (stored in auth.json)
```

or set the fallback env var `XIAOMI_API_KEY`.

## Install

```bash
pi install npm:pi-mimo-search     # from npm
pi install git:github.com/rioliu/pi-mimo-search   # from git
```

Then restart Pi or `/reload`. The `web_search` tool appears in the tool list.

## Usage

Just ask the model to search, or let it decide — the tool description tells it when search is appropriate.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | — | Search query in the user's language |
| `force` | bool | `false` | `force_search`: search even if the model thinks it knows the answer |
| `maxKeyword` | int 1-3 | `1` | Concurrent keywords per round — **each is one billed invocation** |
| `results` | int 1-5 | `2` | Pages returned/injected — more pages = more input tokens |

The result's `structuredContent` (declared via `outputSchema`) carries `answer`, `citations[]`, `usage` (tokens + `pluginInvocations`/`pages`) and `cost` — available to codemode scripts and other programmatic callers.

## How billing works

MiMo charges the plugin **separately from tokens and separately from Token Plan quota**:

- **Plugin fee**: CNY 16 / 1,000 invocations (CN region). One search round fires up to `max_keyword` concurrent keyword searches = that many invocations.
- **Tokens**: search content is injected into the side-call prompt — flash-model prices, charged to your PAYG balance.

Typical call: `max_keyword: 1` → **CNY 0.016 + a few hundred flash tokens ≈ CNY 0.02**. CNY 50 ≈ 3,000+ searches.

The tool prints its own cost line per call and returns the same numbers structurally, so session totals stay reconcilable with the [Billing console](https://platform.xiaomimimo.com/#/console/usage).

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

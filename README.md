# opencli-plugin-tradingview

TradingView adapter for [OpenCLI](https://github.com/jackwener/opencli). Two kinds of commands:

- **Navigation** — drive a real TradingView session through the bound browser tab (chart navigation, symbol panels, market views). Returns `{url, title}`.
- **Extraction** — return structured data (symbol news, fundamentals, computed technical signals, macro calendar) so any LLM/agent can consume TradingView's surface as rows, not screenshots.

Granularity follows the OpenCLI convention: **one endpoint = one file = one data shape**. Each extraction adapter is its own command rather than a `--panel` flag on a generic navigator, mirroring how the built-in `@jackwener/opencli` adapters are laid out (1300+ single-endpoint `.js` files).

## Status

- **Extraction adapters** (`news`, `financials`, `technicals`, `econ-calendar`, `earnings`) — verified end-to-end against live TradingView on both a US ticker (`AAPL`) and an A-share (`600519`). These return real rows.
- **Navigation commands** (`navigate`, `view`, `market`) — open/drive tabs and read `document.title`. `navigate` is a write op (preserves chart layout); pass `--no-vis-check` if a visibility-state assertion fires when the browser window loses focus.
- **Known gaps**: `view --panel forecast` (analyst price targets) is SVG-rendered and not cleanly scrapable yet; `view` panels `ideas`/`minds` are navigation-only (no structured extraction).

## Install

```bash
# Prereq: opencli installed + browser extension bound to a TradingView tab
# opencli browser bind --domain tradingview.com --workspace bound:tv-chart

# From local dev directory
opencli plugin install file:///D:/workspace/opencli-plugin-tradingview

# From Gitea
opencli plugin install git+https://git.xart.top:8418/claudeQWQ/opencli-plugin-tradingview.git

# From GitHub
opencli plugin install git+https://github.com/2233admin/opencli-plugin-tradingview.git
```

## Commands

### Extraction (return structured rows)

| Command                              | File             | Output columns                                    | Description                                                                 |
| ------------------------------------ | ---------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| `tradingview news <symbol>`          | news.ts          | `date, source, headline, url`                     | Symbol-level news headlines                                                 |
| `tradingview financials <symbol>`    | financials.ts    | `metric, value`                                   | Key statistics / fundamentals (market cap, P/E, EPS, dividend, debt, cash…) |
| `tradingview technicals <symbol>`    | technicals.ts    | `section, verdict, sell, neutral, buy`            | Computed technical signals (Oscillators / Moving Averages / Summary)        |
| `tradingview econ-calendar`          | econ-calendar.ts | `date, country, title, importance, actual, …`     | Macro economic calendar (no browser/login — hits the widget JSON endpoint)  |
| `tradingview earnings`               | earnings.ts      | `symbol, name, date, eps_estimate, eps_last, market_cap` | Upcoming earnings calendar for a region (no browser/login — hits the scanner JSON endpoint) |

### Navigation (open/drive tabs, return `{url, title}`)

| Command                               | File         | Description                                                                  |
| ------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `tradingview navigate <symbol>`       | navigate.ts  | Navigate the bound chart tab to a symbol, preserving layout (write op)       |
| `tradingview view <symbol> [--panel]` | view.ts      | Open a symbol panel (`overview`/`ideas`/`forecast`/`minds`) in a new tab     |
| `tradingview market <category>`       | market.ts    | Open a market-level page (heatmap / screener / bonds / options / pine-library) |

Shared utilities live in `_helpers.ts` (`_` prefix marks internal, not registered as a command). All browser commands use the same `Strategy.COOKIE + siteSession:'persistent' + navigateBefore:false + domain` shape (cross-referenced against official `@jackwener/opencli/clis/chatgpt/ask.js`); `econ-calendar` is `browser:false` (plain `fetch`, no session needed).

### Examples

```bash
# Extraction — structured rows
opencli browser --workspace bound:tv-chart tradingview news 600519
opencli browser --workspace bound:tv-chart tradingview financials NASDAQ:AAPL
opencli browser --workspace bound:tv-chart tradingview technicals 600519
opencli tradingview econ-calendar --countries US,CN,EU,JP --days 7 --min-importance 1
opencli tradingview earnings --region america --days 7 --limit 50
opencli tradingview earnings --region china --days 14

# Navigation
opencli browser --workspace bound:tv-chart tradingview navigate 600519        # A-share auto-prefix: 600519 -> SSE:600519
opencli browser --workspace bound:tv-chart tradingview navigate NASDAQ:AAPL
opencli browser --workspace bound:tv-chart tradingview view 600519 --panel overview
opencli browser --workspace bound:tv-chart tradingview market heatmap-stock --region cn
opencli browser --workspace bound:tv-chart tradingview market options --symbol AAPL
```

## Robust extraction (why this survives TradingView redeploys)

TradingView's wrapping CSS class hashes (e.g. `vLbFM67a`) rotate on **every deploy**, so the extraction adapters never key off full hashed class names. Instead each anchors on a stable signal:

- **news** → `a[href^="/news/"]` anchor pattern
- **financials** → leaf `label\nvalue` blocks where the value contains a digit
- **technicals** → the counter-text pattern (`Sell N  Neutral N  Buy N`) for sections, and the gauge container's **semantic class prefix** (`container-{sell|buy|neutral|strong-sell|strong-buy}-<hash>`) for the verdict — the hash rotates, the prefix doesn't. (The dial's center text is unreliable: it renders all five labels and hides four via CSS, so the first text node is always "Neutral".)
- **econ-calendar** → bypasses the iframe-isolated widget entirely; calls the JSON endpoint the widget itself uses (`economic-calendar.tradingview.com/events`), which only needs an `Origin` header to clear the 403 gate.
- **earnings** → same trick against the screener backend (`scanner.tradingview.com/<region>/scan`): a JSON POST filtering `earnings_release_next_date in_range [now, now+days]`, sorted by market cap. Region is path-based (one call = one region), so no iframe and no login. Uses `description` (full company name) over `name` (the bare ticker code).

TradingView wraps numeric values in Unicode directional-isolate marks (U+202A/U+202C/U+2068/U+2069); extractors strip these before parsing.

## Environment

| Variable    | Default     | Description                          |
| ----------- | ----------- | ------------------------------------ |
| `TV_LAYOUT` | `UkpUJ5dZ`  | Default TradingView chart layout id  |

## A-share symbol auto-prefixing

| Input                   | Resolved                                     |
| ----------------------- | -------------------------------------------- |
| `600519`                | `SSE:600519`                                 |
| `000001`                | `SZSE:000001`                                |
| `300750`                | `SZSE:300750`                                |
| `AAPL`                  | `AAPL` (TradingView fuzzy-resolves exchange) |
| anything containing `:` | kept verbatim                                |

## Design principle

This plugin complements OpenCLI rather than duplicating it: **anything OpenCLI already covers is not re-implemented** — the adapters only fill gaps OpenCLI lacks (TradingView's session-gated symbol panels and computed signals) or provide a superset. Crypto OHLCV, for instance, is intentionally out of scope (the binance adapter already covers klines).

## Related

- [`tradingview-cli`](https://git.xart.top:8418/claudeQWQ/tradingview-cli) — original 16-tool sh stack (BBX-driven). This plugin is the OpenCLI-native re-port; both coexist.
- [`@jackwener/opencli`](https://www.npmjs.com/package/@jackwener/opencli) — the host framework.

## License

Apache-2.0

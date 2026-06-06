# opencli-plugin-tradingview

TradingView adapter for [OpenCLI](https://github.com/jackwener/opencli). Three kinds of commands:

- **Chart automation control** — drive a persistent chart tab through the Charting-Library widget API (`window.TradingViewApi.activeChart()`): switch symbol/timeframe, add/remove indicators, draw trendlines/horizontal lines, screenshot, save/load layouts, and batch-scan a basket for anomalies. On-demand, single command per call. No order placement — read/analyse/annotate only.
- **Navigation** — drive a real TradingView session through the bound browser tab (chart navigation, symbol panels, market views). Returns `{url, title}`.
- **Extraction** — return structured data (symbol news, fundamentals, computed technical signals, macro calendar) so any LLM/agent can consume TradingView's surface as rows, not screenshots.

Granularity follows the OpenCLI convention: **one endpoint = one file = one data shape**. Each extraction adapter is its own command rather than a `--panel` flag on a generic navigator, mirroring how the built-in `@jackwener/opencli` adapters are laid out (1300+ single-endpoint `.js` files).

## Status

- **Chart automation control** (`chart`, `indicator`, `drawing`, `capture`, `layout`, `scan`, `readings`) — verified live against the bound chart: symbol/timeframe switch + read-back, indicator add/list/remove, hline/trendline draw + clear, screenshot-to-file, saved-layout list/load, basket scan with z-score anomaly flagging, and reading the live plotted values of any loaded study (built-in or open-source Pine). Drives the Charting-Library widget API directly. **No order placement** — analysis and annotation only.
- **Open-source Pine load** (`indicator add --pine "PUB;<hash>"`) — verified end-to-end: `createStudy(name)` resolves built-in studies by display name only ("unexpected study id" for community scripts), so `--pine` resolves the script's `metaInfo` server-side via the study repository (`repo.findById({type:'pine', pineId, pineVersion})` → server compile) and inserts it through the internal model (`model._insertStudy`), which allocates a real, removable entity id (the id settles asynchronously, so the command polls until it appears). Works for **any public script id whether or not it is already on the chart** and needs no saved layout. Unattended — no DOM clicking, no UI search.
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

## Unified CLI wrapper

This fork also ships a small `tv` wrapper that normalizes the command surface across backends:

```bash
# Default backend: OpenCLI browser/cookie session
npm run tv -- config set layout afALGzKj
npm run tv -- status
npm run tv -- chart NASDAQ:AAPL --interval 1h
npm run tv -- readings
npm run tv -- watch NASDAQ:AAPL --interval 1h --once
npm run tv -- watch NASDAQ:AAPL --interval 1h --every 60

# Fallback backends
npm run tv -- --backend cdp quote      # tradingview-mcp-jackson CLI / localhost:9222
npm run tv -- --backend mcp quote      # alias for the CDP-compatible CLI path
npm run tv -- --backend bbx status     # forwards to BBX: bbx tv status
```

Backends:

| Backend | Purpose |
| --- | --- |
| `opencli` | Default. Reuses browser cookie/session through OpenCLI and this plugin. |
| `cdp` | Calls `tradingview-mcp-jackson`'s CLI (`TV_CDP_CLI`) against a CDP target. |
| `mcp` | CLI-compatible alias for the CDP/MCP feature set. |
| `bbx` | Forwards to legacy BBX tooling (`TV_BBX_CMD`, default `bbx`). |

Persist the active TradingView layout once so commands do not fall back to a private default layout:

```bash
npm run tv -- config set layout <your-layout-id>
```

### Watch mode

`tv watch` turns the wrapper into a monitoring command. It probes chart state, indicator readings, technical ratings, news, and financials from the real OpenCLI/TradingView session and prints one JSON snapshot per cycle. Failing sources are kept in the snapshot with `ok: false` instead of aborting the whole watch run, so scanner/calendar outages do not break chart monitoring.

```bash
npm run tv -- watch NASDAQ:AAPL --interval 1h --once
npm run tv -- watch NASDAQ:AAPL --interval 1h --every 60
npm run tv -- watch NASDAQ:AAPL --sources chart,readings,technicals,financials,earnings,screen-cn,econ-calendar --once
```

This is monitoring/analysis only. It does not place orders or control a broker panel.

Wrapper smoke tests stay dry-run only. Use `npm run test:watch:integration` when you want to verify the live OpenCLI/TradingView browser session.

## Commands

### Chart automation control (drive the bound chart via the widget API)

These commands operate on a persistent automation tab that owns its own chart. The first command navigates it to `TV_LAYOUT` (cookies are shared with your logged-in Chrome profile, so saved layouts load authenticated); subsequent commands reuse the live tab, preserving symbol/studies/drawings between calls. All drive the **stable, versioned** `window.TradingViewApi.activeChart()` API — no hashed CSS, no DOM clicking.

| Command                                          | File         | Output columns                    | Description                                                                          |
| ------------------------------------------------ | ------------ | --------------------------------- | ------------------------------------------------------------------------------------ |
| `tradingview chart [symbol] [--interval]`        | chart.ts     | `symbol, resolution`              | Switch symbol and/or timeframe (write op, preserves layout). Reads state back.       |
| `tradingview indicator <action> [...]`           | indicator.ts | `action, id, name`                | `list`/`add`/`remove`/`clear` studies. Built-in by `--name`/`--inputs` (RSI, MACD, MA, BB, …); **any public open-source Pine** by `--pine "PUB;<hash>"` (`--pine-version`), loaded or not |
| `tradingview drawing <action> [...]`             | drawing.ts   | `action, id, detail`              | `list`/`hline`/`trendline`/`remove`/`clear` shapes (`--price`, `--points`, `--id`)   |
| `tradingview capture [--path] [--img-format]`    | capture.ts   | `symbol, path`                    | Screenshot the chart, tagged with the current symbol (reuses openCLI's screenshot)   |
| `tradingview layout <action> [--id/--name]`      | layout.ts    | `id, name, symbol, resolution`    | `list`/`load` the account's saved chart layouts                                      |
| `tradingview scan <symbols> [...]`               | scan.ts      | `symbol, close, change_pct, zscore, anomaly, bars, shot` | Batch-inspect a basket (last bar, change%, return z-score anomaly, optional screenshot); restores the original symbol when done |
| `tradingview readings [--id] [--all-plots]`      | readings.ts  | `study, id, plot, value, time`    | Read the **current plotted values** of every loaded study — built-in or open-source/community Pine — via the internal model |

### Extraction (return structured rows)

| Command                              | File             | Output columns                                    | Description                                                                 |
| ------------------------------------ | ---------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| `tradingview news <symbol>`          | news.ts          | `date, source, headline, url`                     | Symbol-level news headlines                                                 |
| `tradingview financials <symbol>`    | financials.ts    | `metric, value`                                   | Key statistics / fundamentals (market cap, P/E, EPS, dividend, debt, cash…) |
| `tradingview technicals <symbol>`    | technicals.ts    | `section, verdict, sell, neutral, buy`            | Computed technical signals (Oscillators / Moving Averages / Summary)        |
| `tradingview econ-calendar`          | econ-calendar.ts | `date, country, title, importance, actual, …`     | Macro economic calendar (no browser/login — hits the widget JSON endpoint)  |
| `tradingview earnings`               | earnings.ts      | `symbol, name, date, eps_estimate, eps_last, market_cap` | Upcoming earnings calendar for a region (no browser/login — hits the scanner JSON endpoint) |
| `tradingview screen-cn`              | screen-cn.ts     | `symbol, name, price, change_pct, volume, market_cap, pe, dividend` | A-share market movers via scanner API: large-cap/active/gainers/losers/best-performing/high-dividend/all-stocks (no browser/login — scanner endpoint) |
| `tradingview alert <action>`         | alert.ts         | `alert_id, symbol, price, condition, status`             | `list`/`create`/`delete` price alerts via the REST API (persistent chart tab) |
| `tradingview alert-batch <action> <csv>` | alert-batch.ts | `action, symbol, alert_id, price, status`                | Batch deploy/validate/delete from CSV (`action=deploy|validate|delete|dry-run`, `--csv` or stdin `-`) |
| `tradingview watchlist <action>`     | watchlist.ts      | `index, name, symbols, symbols_count`                   | `list`/`add`/`remove`/`rename` lists; CSV export via `--export` |

### Navigation (open/drive tabs, return `{url, title}`)

| Command                               | File         | Description                                                                  |
| ------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `tradingview navigate <symbol>`       | navigate.ts  | Navigate the bound chart tab to a symbol, preserving layout (write op)       |
| `tradingview view <symbol> [--panel]` | view.ts      | Open a symbol panel (`overview`/`ideas`/`forecast`/`minds`) in a new tab     |
| `tradingview market <category>`       | market.ts    | Open a market-level page (heatmap / screener / bonds / options / pine-library) |

Shared utilities live in `_helpers.ts` (`_` prefix marks internal, not registered as a command). All browser commands use the same `Strategy.COOKIE + siteSession:'persistent' + navigateBefore:false + domain` shape (cross-referenced against official `@jackwener/opencli/clis/chatgpt/ask.js`); `econ-calendar` is `browser:false` (plain `fetch`, no session needed).

### Examples

```bash
# Chart automation control — drive the persistent chart tab
opencli tradingview chart NASDAQ:AAPL --interval 1h      # switch symbol + timeframe
opencli tradingview chart OKX:ETHUSD --interval 15m      # crypto, 15-minute
opencli tradingview indicator add --name "Relative Strength Index" --inputs "[21]"
opencli tradingview indicator add --pine "PUB;<hash>"    # load any public open-source Pine by scriptIdPart
opencli tradingview indicator add --pine "PUB;<hash>" --pine-version 2 --inputs "[12,26,9]"
opencli tradingview indicator list                       # -> [{id, name}]
opencli tradingview indicator remove --id <id>
opencli tradingview drawing hline --price 3500           # horizontal line at a level
opencli tradingview drawing trendline --points "1716800000,3400,1716886400,3600"
opencli tradingview drawing list                         # -> [{id, detail}]
opencli tradingview capture --img-format png             # screenshot -> file path
opencli tradingview layout list                          # saved layouts
opencli tradingview layout load --name "My ETH setup"
opencli tradingview scan "NASDAQ:AAPL,600519,OKX:ETHUSD" --lookback 30 --z-threshold 2 --capture
opencli tradingview readings                             # current values of every loaded study
opencli tradingview readings --id "MACD"                # filter by study id or name substring
opencli tradingview readings --all-plots                # include colorer/hidden/unnamed internal plots

# Extraction — structured rows
opencli browser --workspace bound:tv-chart tradingview news 600519
opencli browser --workspace bound:tv-chart tradingview financials NASDAQ:AAPL
opencli browser --workspace bound:tv-chart tradingview technicals 600519
opencli tradingview econ-calendar --countries US,CN,EU,JP --days 7 --min-importance 1
opencli tradingview earnings --region america --days 7 --limit 50
opencli tradingview earnings --region china --days 14

# Alerts
opencli tradingview alert list                                  # list all alerts
opencli tradingview alert create --symbol SSE:600519 --price 1500 --condition cross_up --message "Moutai breakout"
opencli tradingview alert delete --id 12345
opencli tradingview alert-batch deploy alerts.csv              # CSV: symbol,condition,price,message,webhook,expire_days,currency,once
opencli tradingview alert-batch validate alerts.csv             # validate without creating
opencli tradingview alert-batch dry-run alerts.csv              # show what would be created
cat alerts.csv | opencli tradingview alert-batch deploy -       # stdin input

# A-share screen (no browser needed)
opencli tradingview screen-cn --subtype large-cap --limit 50
opencli tradingview screen-cn active
opencli tradingview screen-cn gainers
opencli tradingview screen-cn high-dividend

# Canary (drift detection before real runs)
opencli tradingview canary                                     # probe 5 pages, restore layout
opencli tradingview canary --skip pine,market                  # skip two probes
opencli tradingview canary --tsv ./canary.tsv                   # append TSV log

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

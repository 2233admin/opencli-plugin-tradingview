# opencli-plugin-tradingview

TradingView adapter for [OpenCLI](https://github.com/jackwener/opencli) — exposes chart navigation, symbol panels, and market views as opencli commands so any LLM/agent can drive a real TradingView session through the bound browser tab.

> **⚠️ WIP / smoke-pending (v0.1.0-alpha.1)** — code is spec-compliant against `@jackwener/opencli` v1.8.0 (cross-checked vs official `clis/chatgpt/ask.js`), but end-to-end smoke against a live bound TradingView tab has **not** passed yet. Current blocker: visibility-state assertion fires when Edge window loses focus during PS invocation; needs rearch (move assertion to future snapshot command, keep `navigate` minimal). Tracking: see [Known limitations](#known-limitations).
>
> **OK to**: read source as a reference for OpenCLI third-party plugin layout (one command per file at root, `_helpers.ts` for shared utils, all five required `cli()` fields set).
> **Not OK to**: depend on commands actually running end-to-end yet.

## Install

```bash
# Prereq: opencli installed + browser extension bound to TradingView tab
# opencli browser bind --domain tradingview.com --workspace bound:tv-chart

# From local dev directory
opencli plugin install file:///D:/workspace/opencli-plugin-tradingview

# From Gitea (after publish)
opencli plugin install git+https://git.xart.top:8418/claudeQWQ/opencli-plugin-tradingview.git
```

## Commands

| Command                                | File         | Description                                                                  |
| -------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `tradingview navigate <symbol>`        | navigate.ts  | Navigate the bound chart tab to a symbol (A-share auto-prefix supported)     |
| `tradingview view <symbol> [--panel]`  | view.ts      | Open a symbol panel (news / ideas / financials / technicals / forecasts) in a new tab |
| `tradingview market <category>`        | market.ts    | Open a market-level page (heatmap / screener / calendar / pine-library)      |

Layout follows the OpenCLI convention: one command per file at repo root, shared utilities in `_helpers.ts` (`_` prefix marks internal, not registered as a command). Cross-reference: official `@jackwener/opencli/clis/chatgpt/ask.js` (same `Strategy.COOKIE + siteSession:'persistent' + navigateBefore:false + domain` shape).

### Examples

```bash
# Navigate the bound chart to Moutai (A-share auto-prefix: 600519 -> SSE:600519)
opencli browser --workspace bound:tv-chart tradingview navigate 600519

# Same, explicit ticker
opencli browser --workspace bound:tv-chart tradingview navigate NASDAQ:AAPL

# Open Moutai financials in a new tab
opencli browser --workspace bound:tv-chart tradingview view 600519 --panel financials-overview

# A-share sector heatmap
opencli browser --workspace bound:tv-chart tradingview market heatmap-stock --region cn

# AAPL options chain
opencli browser --workspace bound:tv-chart tradingview market options --symbol AAPL
```

## Environment

| Variable    | Default     | Description                                              |
| ----------- | ----------- | -------------------------------------------------------- |
| `TV_LAYOUT` | `UkpUJ5dZ`  | Default TradingView chart layout id                      |

## A-share symbol auto-prefixing

| Input                   | Resolved                                |
| ----------------------- | --------------------------------------- |
| `600519`                | `SSE:600519`                            |
| `000001`                | `SZSE:000001`                           |
| `300750`                | `SZSE:300750`                           |
| `AAPL`                  | `AAPL` (TradingView fuzzy-resolves exchange) |
| anything containing `:` | kept verbatim                           |

## Known limitations

This plugin uses OpenCLI's `Strategy.UI` mode. Per the upstream `tradingview-cli` probe (May 2026):

- **Works**: navigation, click chains (toolbar/menu), `<title>` reads, snapshots, screenshots, new-tab management
- **Does NOT work yet** (carried over from `tradingview-cli` honest-gap-list):
  - **Symbol search injection** — TradingView's search uses a non-standard React event chain that ignores standard `input` events. Affects flows that need to type into the in-app search box.
  - **Alert deletion confirm popup** — new "您真的要删除..." dialog needs an extra confirm step (not yet handled).
  - **Alert webhook URL field** — rejected by the same controlled-input issue.

## Related

- [`tradingview-cli`](https://git.xart.top:8418/claudeQWQ/tradingview-cli) — original 16-tool sh stack (BBX-driven). This plugin is the OpenCLI-native re-port; both will coexist.
- [`@jackwener/opencli`](https://www.npmjs.com/package/@jackwener/opencli) — the host framework.

## License

Apache-2.0

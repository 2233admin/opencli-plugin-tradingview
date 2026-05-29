import { CommandExecutionError } from '@jackwener/opencli/errors';
import type { IPage } from '@jackwener/opencli/registry';

export const TRADINGVIEW_DOMAIN = 'www.tradingview.com';
export const DEFAULT_LAYOUT = process.env.TV_LAYOUT ?? 'UkpUJ5dZ';

// A-share auto-prefixing: 6XXXXX -> SSE:, 0XXXXX/3XXXXX -> SZSE:, anything with ':' kept verbatim.
export function normalizeSymbol(raw: string): string {
  const s = raw.trim();
  if (s.includes(':')) return s;
  if (/^6\d{5}$/.test(s)) return `SSE:${s}`;
  if (/^[03]\d{5}$/.test(s)) return `SZSE:${s}`;
  return s;
}

// Chrome throttles history fetch on hidden tabs — empty K-lines guaranteed even though title shows live quote.
export async function assertVisible(page: IPage): Promise<void> {
  const vis = await page.evaluate<string>('document.visibilityState');
  if (vis === 'hidden') {
    throw new CommandExecutionError(
      'TradingView chart: document.visibilityState=hidden — chart history fetch will be throttled.',
      'Bring the browser window/tab to foreground, or pass --no-vis-check to bypass.',
    );
  }
}

// Safe literal for interpolating a JS value into a string we hand to page.evaluate().
// JSON.stringify escapes quotes/backslashes/newlines, so user-supplied symbols, study
// names, JSON inputs etc. cannot break out of the expression. undefined -> 'null'.
export function jsLit(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// Human interval -> TradingView Charting-Library resolution code.
//   1m/5m/15m/... -> "1"/"5"/"15"   (minutes are bare numbers in TV)
//   1h/2h/4h       -> "60"/"120"/"240"
//   1d/1w/1mo      -> "1D"/"1W"/"1M"
//   pure digits    -> verbatim (already a TV minute code)
//   anything else  -> uppercased (lets "1D"/"1W"/"1M" pass through untouched)
export function normalizeInterval(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/^(\d+)(m|min|h|hour|d|day|w|week|mo|month)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === 'm' || unit === 'min') return String(n);
    if (unit === 'h' || unit === 'hour') return String(n * 60);
    if (unit === 'd' || unit === 'day') return `${n}D`;
    if (unit === 'w' || unit === 'week') return `${n}W`;
    return `${n}M`; // mo / month
  }
  return raw.trim().toUpperCase();
}

// Probe for the Charting-Library widget API. Returns a state code:
//   'ok'        — window.TradingViewApi.activeChart() is live and usable
//   'no-api'    — window.TradingViewApi missing (blank tab / wrong page)
//   'no-chart'  — TradingViewApi present but activeChart isn't a function yet
//   'no-widget' — activeChart() returned something without a symbol() method
//   'err:...'   — the probe threw
const CHART_STATE_EXPR =
  "(()=>{ try { const a = window.TradingViewApi; if (typeof a !== 'object' || !a) return 'no-api'; if (typeof a.activeChart !== 'function') return 'no-chart'; const c = a.activeChart(); return (c && typeof c.symbol === 'function') ? 'ok' : 'no-widget'; } catch (e) { return 'err:' + e.message; } })()";

async function chartState(page: IPage): Promise<string> {
  return page.evaluate<string>(CHART_STATE_EXPR);
}

// Ensure the adapter's tab is on a live TradingView chart, navigating if needed.
//
// A persistent site adapter (siteSession:'persistent') owns its OWN automation tab
// (surface 'adapter'), distinct from any tab bound manually via `opencli browser bind`
// (surface 'browser'). On the first command that adapter tab is blank, so we navigate
// it to the chart layout. Cookies are shared with the user's logged-in Chrome profile
// (Strategy.COOKIE), so the saved layout loads authenticated; guest mode still yields a
// working activeChart for everything except saved-layout ops.
//
// We navigate ONLY when the API isn't already live: with keepTab the tab persists across
// on-demand invocations, so a fast-path skip preserves chart state (symbol, studies,
// drawings) between commands instead of reloading every time.
export async function ensureChart(page: IPage): Promise<void> {
  if ((await chartState(page)) === 'ok') return;

  const layout = DEFAULT_LAYOUT.trim();
  const url = layout
    ? `https://${TRADINGVIEW_DOMAIN}/chart/${layout}/`
    : `https://${TRADINGVIEW_DOMAIN}/chart/`;
  await page.goto(url);

  // Chart bootstrap is async — poll until the Charting-Library API comes alive.
  const deadline = Date.now() + 30_000;
  let state = 'no-api';
  while (Date.now() < deadline) {
    state = await chartState(page);
    if (state === 'ok') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new CommandExecutionError(
    `TradingView chart API unavailable after navigating to ${url} (${state}).`,
    'The chart did not finish loading. Check the browser extension is running and the site is reachable; set TV_LAYOUT to a valid layout id if the default is private.',
  );
}

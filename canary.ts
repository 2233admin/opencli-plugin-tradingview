import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, DEFAULT_LAYOUT } from './_helpers.js';

// DOM / URL drift canary: navigates 5 representative TV URLs and checks one stable
// signal per page. TV silently rewrites class names, URL paths, and table structures.
// When that happens all other tools silently produce empty output without erroring.
// Running this before any other TV command catches drift before it hits a real run.
//
// This is the OpenCLI plugin equivalent of tv-canary.sh (BBX era). It uses the
// adapter's persistent chart tab (not a bound browser tab), navigates through the 5 URLs,
// then restores the original layout. Total wall clock ~40s.
//
// 5 canary targets (verified 2026-05-08 baseline):
//   chart       https://cn.tradingview.com/chart/<TV_LAYOUT>/  <title> contains "▼" or "▲"
//   screen-cn    /markets/stocks-china/market-movers-active/    <table> rows ≥ 10
//   view        /symbols/SSE:600519/financials-overview/     body.innerText.length ≥ 3000
//   market      /heatmap/stock/                            <canvas> ≥ 1
//   pine        /script/EYO7FUhF...                          innerText contains "Source code" / "源代码"
//

interface Canary {
  name: string;
  url: string;
  check: string;
  threshold: number;
  unit: string;
}

// Stable signal probe expressions injected via page.evaluate().
// Returns JSON string so the caller can parse the result safely.
const CANARIES: Canary[] = [
  {
    name: 'chart',
    url: '', // resolved dynamically to DEFAULT_LAYOUT
    check: `(() => { const t = document.title; return /[▼▲]/.test(t) ? t : 'NO_ARROW' })()`,
    threshold: 0,
    unit: 'title-has-arrow',
  },
  {
    name: 'screen-cn',
    url: '/markets/stocks-china/market-movers-active/',
    check: `(() => { const t = document.querySelector('table'); if (!t) return 0; const rows = t.querySelectorAll('tbody tr'); return rows.length; })()`,
    threshold: 10,
    unit: 'rows',
  },
  {
    name: 'view',
    url: '/symbols/SSE:600519/financials-overview/',
    check: `document.body.innerText.length`,
    threshold: 3000,
    unit: 'body-len',
  },
  {
    name: 'market',
    url: '/heatmap/stock/',
    check: `document.querySelectorAll('canvas').length`,
    threshold: 1,
    unit: 'canvas',
  },
  {
    name: 'pine',
    url: '/script/EYO7FUhFz8x7zLmqvHCnW4w3XjK2pR6Qa/',
    check: `(/源代码|查看源代码|Source code/i.test(document.body.innerText) ? 1 : 0)`,
    threshold: 1,
    unit: 'source-marker',
  },
];

// Resolve the chart URL (empty path means use the saved layout).
function chartUrl(): string {
  const layout = DEFAULT_LAYOUT?.trim();
  return layout
    ? `https://${TRADINGVIEW_DOMAIN}/chart/${layout}/`
    : `https://${TRADINGVIEW_DOMAIN}/chart/`;
}

// Run one canary check on the current page.
async function runCheck(page: Parameters<typeof cli>[0], c: Canary): Promise<{ name: string; status: 'PASS' | 'FAIL' | 'SKIP' | 'INVALID'; detail: string }> {
  const url = c.url
    ? (c.url.startsWith('http') ? c.url : `https://${TRADINGVIEW_DOMAIN}${c.url}`)
    : chartUrl();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // Give SPA time to hydrate
    await new Promise((r) => setTimeout(r, 3000));

    const raw = await page.evaluate<string>(`(${c.check})()`);
    let value: number;
    if (raw === 'NO_ARROW') {
      return { name: c.name, status: 'FAIL', detail: raw };
    }
    value = parseFloat(raw);
    if (isNaN(value)) {
      return { name: c.name, status: 'INVALID', detail: `probe returned non-numeric: ${raw.slice(0, 80)}` };
    }

    if (c.threshold === 0) {
      // Boolean check (title-has-arrow)
      return { name: c.name, status: 'PASS', detail: `${c.unit} (${raw.slice(0, 60)})` };
    }
    const ok = value >= c.threshold;
    return {
      name: c.name,
      status: ok ? 'PASS' : 'FAIL',
      detail: `${c.unit}=${value} (want ≥${c.threshold})`,
    };
  } catch (e) {
    return { name: c.name, status: 'FAIL', detail: String(e instanceof Error ? e.message : e).slice(0, 100) };
  }
}

cli({
  site: 'tradingview',
  name: 'canary',
  description: 'DOM/URL drift canary: probe 5 TV pages for stable signals and flag breakage before it hits real runs',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'skip', help: 'Comma-separated canary names to skip (e.g. pine,view)' },
    { name: 'no-restore', help: 'Skip restoring the chart layout at the end (flag)' },
    { name: 'tsv', help: 'Append TSV row to this file path (for cron logging)' },
  ],
  columns: ['name', 'status', 'detail'],
  func: async (page, kwargs): Promise<{ name: string; status: string; detail: string }[]> => {
    const skipNames = String(kwargs.skip ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const doRestore = !kwargs['no-restore'];
    const tsvPath = kwargs.tsv ? String(kwargs.tsv) : '';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Navigate to a blank page first to establish the tab
    await page.goto(`https://${TRADINGVIEW_DOMAIN}/`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 1000));

    const results: { name: string; status: string; detail: string }[] = [];

    for (const c of CANARIES) {
      if (skipNames.includes(c.name)) {
        results.push({ name: c.name, status: 'SKIP', detail: 'skipped by --skip' });
        continue;
      }
      const r = await runCheck(page, c);
      results.push({ name: r.name, status: r.status, detail: r.detail });

      // Append to TSV log if requested
      if (tsvPath) {
        const fs = await import('fs');
        const row = `${ts}\t${r.name}\t${r.status}\t${r.detail}`;
        fs.appendFileSync(tsvPath, row + '\n');
      }
    }

    // Restore to chart layout
    if (doRestore) {
      await page.goto(chartUrl(), { waitUntil: 'domcontentloaded', timeout: 15_000 });
    }

    return results;
  },
});

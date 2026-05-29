import { cli, Strategy } from '@jackwener/opencli/registry';
import { TRADINGVIEW_DOMAIN, normalizeSymbol } from './_helpers.js';

// TV financials-overview renders key statistics as leaf "label\nvalue" blocks
// (Market cap, P/E, EPS, dividend yield, debt, cash...). The wrapping class
// hashes rotate on every deploy, so we key off the STABLE structure instead:
// a leaf element whose innerText is exactly two non-empty lines where the
// second line (the value) contains a digit. Dedup by label keeps the leaf and
// drops nested duplicates. Same robustness principle as the news adapter.
cli({
  site: 'tradingview',
  name: 'financials',
  description: 'Extract symbol key statistics / fundamentals (market cap, P/E, EPS, dividend, debt, cash...)',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [{ name: 'symbol', positional: true, required: true, help: 'e.g. 600519, AAPL, NASDAQ:AAPL' }],
  columns: ['metric', 'value'],
  func: async (page, kwargs) => {
    const sym = normalizeSymbol(String(kwargs.symbol));
    const urlSym = sym.replace(/:/g, '-');
    const url = `https://www.tradingview.com/symbols/${urlSym}/financials-overview/`;

    if (page.newTab) {
      await page.newTab(url);
    } else {
      await page.goto(url);
    }
    // Key stats hydrate client-side; the page title settles once data paints.
    await page.wait({ time: 5 });

    const rows = await page.evaluate<Array<{ metric: string; value: string }>>(`(() => {
      const seen = new Map();
      // Strip TV's directional-isolate marks (U+202A/U+202C) that wrap numbers.
      const clean = (s) => (s || '').replace(/[\\u202a\\u202c\\u2068\\u2069]/g, '').trim();
      document.querySelectorAll('div, span, li').forEach(el => {
        const lines = (el.innerText || '').split('\\n').map(s => clean(s)).filter(Boolean);
        if (lines.length !== 2) return;
        const metric = lines[0];
        const value = lines[1];
        // value must carry a digit; metric must be a real label, not a number.
        if (!/[0-9]/.test(value)) return;
        if (!/[A-Za-z\\u4e00-\\u9fa5]/.test(metric)) return;
        if (metric.length > 60 || value.length > 40) return;
        // Drop chart captions / live quote status, not real fundamentals.
        if (/^(Pre-market|Post-market|Market)$/.test(metric) && /update/i.test(value)) return;
        if (/^Period:/.test(value)) return;
        if (/^Last update/i.test(value)) return;
        // Prefer the first (leaf) occurrence; skip duplicates from parent wrappers.
        if (!seen.has(metric)) seen.set(metric, value);
      });
      return [...seen.entries()].map(([metric, value]) => ({ metric, value }));
    })()`);

    return rows;
  },
});

import { cli, Strategy } from '@jackwener/opencli/registry';
import { TRADINGVIEW_DOMAIN, normalizeSymbol } from './_helpers.js';

cli({
  site: 'tradingview',
  name: 'news',
  description: 'Extract the symbol-level news feed (date/source/headline/url) for a symbol',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'symbol', positional: true, required: true, help: 'e.g. 600519, AAPL, NASDAQ:AAPL' },
    { name: 'limit', type: 'int', default: 20, help: 'Max number of headlines to return' },
  ],
  columns: ['date', 'source', 'headline', 'url'],
  func: async (page, kwargs) => {
    const sym = normalizeSymbol(String(kwargs.symbol));
    const limit = Number(kwargs.limit ?? 20);
    const urlSym = sym.replace(/:/g, '-');
    const url = `https://www.tradingview.com/symbols/${urlSym}/news/`;

    if (page.newTab) {
      await page.newTab(url);
    } else {
      await page.goto(url);
    }
    // News list is hydrated client-side; wait for the first article anchor to paint.
    try {
      await page.wait({ selector: 'a[href^="/news/"]', timeout: 6 });
    } catch {
      await page.wait({ time: 3 });
    }

    // Article anchors start with /news/. innerText is "date\nprovider\nheadline" (3 lines),
    // so ordinal indexing is fragile — key off semantic tags/attrs instead. The hash SUFFIX
    // on TV's CSS-module classes rotates per deploy (provider-McDF5yNM), but the readable
    // PREFIX is stable, so [class*="provider"] survives. Verified live 2026-05-30:
    //   date     <- <time datetime="...GMT"> (RFC, machine-parseable; fallback title attr)
    //   source   <- [class*="provider"] innerText (the provider span)
    //   headline <- [data-overflow-tooltip-text] attr (fallback: last innerText line)
    const rows = await page.evaluate<Array<{ date: string; source: string; headline: string; url: string }>>(`(() => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll('a[href^="/news/"]').forEach(a => {
        const href = a.getAttribute('href');
        if (!href || seen.has(href)) return;
        seen.add(href);
        const t = a.querySelector('time');
        const date = t ? (t.getAttribute('datetime') || t.getAttribute('title') || '') : '';
        const prov = a.querySelector('[class*="provider"]');
        const source = prov ? (prov.innerText || prov.textContent || '').trim() : '';
        const tip = a.querySelector('[data-overflow-tooltip-text]');
        let headline = (tip && tip.getAttribute('data-overflow-tooltip-text')) || '';
        if (!headline) {
          const lines = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
          headline = lines.length ? lines[lines.length - 1] : '';
        }
        if (!headline) return;
        out.push({
          date,
          source,
          headline,
          url: 'https://www.tradingview.com' + href,
        });
      });
      return out;
    })()`);

    return rows.slice(0, limit);
  },
});

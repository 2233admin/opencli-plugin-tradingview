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

    // Article anchors start with /news/. Each card innerText is "date\nsource\nheadline".
    // Key off the stable href prefix — TV's class hashes rotate on every deploy.
    const rows = await page.evaluate<Array<{ date: string; source: string; headline: string; url: string }>>(`(() => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll('a[href^="/news/"]').forEach(a => {
        const href = a.getAttribute('href');
        if (!href || seen.has(href)) return;
        seen.add(href);
        const lines = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
        if (lines.length < 2) return;
        const date = lines[0] || '';
        const source = lines[1] || '';
        const headline = lines.slice(2).join(' ') || lines[1] || '';
        out.push({
          date,
          source: lines.length >= 3 ? source : '',
          headline,
          url: 'https://www.tradingview.com' + href,
        });
      });
      return out;
    })()`);

    return rows.slice(0, limit);
  },
});

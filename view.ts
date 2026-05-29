import { cli, Strategy } from '@jackwener/opencli/registry';
import { TRADINGVIEW_DOMAIN, normalizeSymbol } from './_helpers.js';

// 'news', 'financials-overview' and 'technicals' are split out into dedicated
// extraction adapters (`tradingview news`, `tradingview financials`,
// `tradingview technicals`) — one endpoint = one file, per openCLI convention.
// Remaining panels still funnel through `view` until each gets its own
// extraction adapter.
const VIEW_PANELS = [
  'overview',
  'ideas',
  'forecast',
  'minds',
] as const;

cli({
  site: 'tradingview',
  name: 'view',
  description: 'Open a TradingView symbol-level panel (overview/ideas/forecast/minds) in a NEW tab',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'symbol', positional: true, required: true, help: 'e.g. 600519, AAPL, NASDAQ:AAPL' },
    {
      name: 'panel',
      help: 'symbol panel to open',
      default: 'overview',
      choices: [...VIEW_PANELS],
    },
  ],
  columns: ['symbol', 'panel', 'url', 'title'],
  func: async (page, kwargs) => {
    const sym = normalizeSymbol(String(kwargs.symbol));
    const panel = String(kwargs.panel ?? 'overview');
    const urlSym = sym.replace(/:/g, '-');
    const url =
      panel === 'overview'
        ? `https://www.tradingview.com/symbols/${urlSym}/`
        : `https://www.tradingview.com/symbols/${urlSym}/${panel}/`;

    if (page.newTab) {
      await page.newTab(url);
    } else {
      await page.goto(url);
    }
    await page.wait({ time: 3 });
    const title = await page.evaluate<string>('document.title');
    return [{ symbol: sym, panel, url, title }];
  },
});

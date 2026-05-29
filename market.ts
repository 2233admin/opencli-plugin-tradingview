import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN } from './_helpers.js';

type MarketBuilder = (region?: string, symbol?: string) => string;
const MARKETS: Record<string, MarketBuilder> = {
  'heatmap-stock': (region = 'us') => `https://www.tradingview.com/heatmap/stock/?market=${region}`,
  'heatmap-crypto': () => 'https://www.tradingview.com/heatmap/crypto/',
  'heatmap-etf': () => 'https://www.tradingview.com/heatmap/etf/',
  // 'econ-calendar' split out into its own `tradingview econ-calendar` data adapter (browser:false JSON).
  'earnings-calendar': (region = 'us') => `https://www.tradingview.com/earnings-calendar/?countries=${region}`,
  bonds: () => 'https://www.tradingview.com/markets/bonds/prices-all/',
  options: (_region, symbol) => {
    if (!symbol) {
      throw new ArgumentError("market 'options' requires --symbol", 'Example: opencli tradingview market options --symbol AAPL');
    }
    return `https://www.tradingview.com/symbols/${symbol.replace(/:/g, '-')}/options-chain/`;
  },
  'etf-screener': () => 'https://www.tradingview.com/etf-screener/',
  'crypto-screener': () => 'https://www.tradingview.com/crypto-screener/',
  'bond-screener': () => 'https://www.tradingview.com/bond-screener/',
  'forex-screener': () => 'https://www.tradingview.com/forex-screener/',
  'pine-library': () => 'https://www.tradingview.com/scripts/',
};

cli({
  site: 'tradingview',
  name: 'market',
  description: 'Open a TradingView market-level page (heatmap/screener/calendar/pine-library) in a NEW tab',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    {
      name: 'category',
      positional: true,
      required: true,
      help: 'market category',
      choices: Object.keys(MARKETS),
    },
    { name: 'region', help: 'us|cn|world (for heatmap-stock, earnings-calendar)', default: 'us' },
    { name: 'symbol', help: 'symbol (required for category=options)' },
  ],
  columns: ['category', 'url', 'title'],
  func: async (page, kwargs) => {
    const cat = String(kwargs.category);
    const builder = MARKETS[cat];
    if (!builder) {
      throw new ArgumentError(`Unknown market category: ${cat}`, `Allowed: ${Object.keys(MARKETS).join(', ')}`);
    }
    const url = builder(
      kwargs.region ? String(kwargs.region) : undefined,
      kwargs.symbol ? String(kwargs.symbol) : undefined,
    );

    if (page.newTab) {
      await page.newTab(url);
    } else {
      await page.goto(url);
    }
    await page.wait({ time: 3 });
    const title = await page.evaluate<string>('document.title');
    return [{ category: cat, url, title }];
  },
});

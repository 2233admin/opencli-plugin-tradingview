import { cli, Strategy } from '@jackwener/opencli/registry';
import { DEFAULT_LAYOUT, TRADINGVIEW_DOMAIN, assertVisible, normalizeSymbol } from './_helpers.js';

cli({
  site: 'tradingview',
  name: 'navigate',
  aliases: ['nav', 'go'],
  description: 'Navigate the current TradingView chart tab to a symbol (preserves layout)',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'symbol', positional: true, required: true, help: 'e.g. 600519, AAPL, NASDAQ:AAPL, BINANCE:ETHUSDT.P' },
    { name: 'layout', help: `TradingView layout id (default ${DEFAULT_LAYOUT}, override via TV_LAYOUT env)`, default: DEFAULT_LAYOUT },
    { name: 'wait-quote', type: 'number', help: 'ms to wait for live quote arrow (▼/▲) in <title>', default: 4000 },
    { name: 'no-vis-check', type: 'boolean', help: 'skip the document.visibilityState=hidden assertion', default: false },
  ],
  columns: ['symbol', 'url', 'title'],
  func: async (page, kwargs) => {
    const sym = normalizeSymbol(String(kwargs.symbol));
    const layout = String(kwargs.layout ?? DEFAULT_LAYOUT);
    const waitMs = Number(kwargs['wait-quote'] ?? 4000);
    const url = `https://www.tradingview.com/chart/${layout}/?symbol=${encodeURIComponent(sym)}`;

    await page.goto(url);

    if (!kwargs['no-vis-check']) {
      await assertVisible(page);
    }

    // Wait for WebSocket quote feed to populate <title>. Fall through silently on timeout —
    // some symbols (illiquid A-shares pre-open) never paint an arrow.
    try {
      await page.wait({ text: '▼', timeout: waitMs });
    } catch {
      try {
        await page.wait({ text: '▲', timeout: Math.min(1500, waitMs) });
      } catch {
        /* no quote arrow yet, proceed anyway */
      }
    }

    const title = await page.evaluate<string>('document.title');
    return [{ symbol: sym, url, title }];
  },
});

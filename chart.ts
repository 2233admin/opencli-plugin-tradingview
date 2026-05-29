import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import {
  TRADINGVIEW_DOMAIN,
  ensureChart,
  normalizeSymbol,
  normalizeInterval,
  jsLit,
} from './_helpers.js';

// Switch the bound chart's symbol and/or timeframe via the Charting-Library widget
// API (window.TradingViewApi.activeChart().setSymbol / setResolution). This is the
// stable, versioned surface — no hashed CSS, no DOM clicking. Both methods are
// callback-based; we wrap them in a Promise (openCLI's eval awaits promises) with
// timeout fallbacks so a missing callback never hangs the command.
//
// At least one of <symbol> / --interval must be given. Returns the chart's actual
// state read back AFTER the change settled, so the caller sees ground truth.

cli({
  site: 'tradingview',
  name: 'chart',
  description: 'Switch the bound chart symbol and/or timeframe (write op, preserves layout)',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'symbol', positional: true, help: 'Symbol to load (e.g. NASDAQ:AAPL, 600519, OKX:ETHUSD). A-share auto-prefixed.' },
    { name: 'interval', help: 'Timeframe: 1m/5m/15m/1h/4h/1d/1w/1mo, or a raw TV code (15, 240, 1D).' },
  ],
  columns: ['symbol', 'resolution'],
  func: async (page, kwargs) => {
    const rawSym = kwargs.symbol ? String(kwargs.symbol) : '';
    const rawInt = kwargs.interval ? String(kwargs.interval) : '';
    if (!rawSym && !rawInt) {
      throw new ArgumentError(
        'chart needs a symbol and/or --interval',
        'Example: opencli browser --workspace bound:tv-chart tradingview chart NASDAQ:AAPL --interval 1h',
      );
    }
    await ensureChart(page);

    const sym = rawSym ? normalizeSymbol(rawSym) : null;
    const res = rawInt ? normalizeInterval(rawInt) : null;

    const expr = `new Promise((resolve) => {
      const c = window.TradingViewApi.activeChart();
      const SYM = ${jsLit(sym)};
      const RES = ${jsLit(res)};
      let symDone = false, resDone = false;
      const readBack = () => resolve(JSON.stringify({ symbol: c.symbol(), resolution: c.resolution() }));
      const doRes = () => {
        if (resDone) return; resDone = true;
        if (!RES) return readBack();
        try { c.setResolution(RES, readBack); } catch (e) { readBack(); }
        setTimeout(readBack, 2500);
      };
      const doSym = () => { if (symDone) return; symDone = true; doRes(); };
      if (SYM) {
        try { c.setSymbol(SYM, doSym); } catch (e) { doSym(); }
        setTimeout(doSym, 4000);
      } else { doRes(); }
    })`;

    const raw = await page.evaluate<string>(expr);
    const out = JSON.parse(raw) as { symbol: string; resolution: string };
    return [{ symbol: out.symbol, resolution: out.resolution }];
  },
});

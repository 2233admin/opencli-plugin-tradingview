import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import {
  TRADINGVIEW_DOMAIN,
  ensureChart,
  normalizeSymbol,
  normalizeInterval,
  jsLit,
} from './_helpers.js';

// Batch inspection (批量巡检): walk a basket of symbols through the ONE bound chart,
// reading each symbol's last bar + a rolling-return z-score for anomaly flagging, and
// optionally screenshotting each. Drives the chart via setSymbol (like `chart`), reads
// price via the mainSeries bars() collection (last/valueAt), and ALWAYS restores the
// original symbol when done — even on error — so the bound tab is left as found.
//
// This is on-demand and serial by design: there is a single chart widget, so symbols
// are visited one at a time. Price/volume here come from the live chart, NOT a vendor
// SDK — for bulk historical OHLCV use a real data adapter; this is a quick visual sweep.

cli({
  site: 'tradingview',
  name: 'scan',
  description: 'Batch-inspect a basket of symbols (last bar, change%, return z-score anomaly, optional screenshot) via the bound chart',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'symbols', positional: true, required: true, help: 'comma-separated symbols, e.g. "NASDAQ:AAPL,600519,OKX:ETHUSD"' },
    { name: 'interval', help: 'timeframe applied to every symbol: 1m/5m/15m/1h/4h/1d (default: chart current)' },
    { name: 'lookback', type: 'int', default: 30, help: 'lookback bars for the return z-score (default 30)' },
    { name: 'z-threshold', default: '2', help: 'abs z-score that flags an anomaly (default 2)' },
    { name: 'capture', help: 'screenshot each symbol (flag)' },
    { name: 'out-dir', default: '.', help: 'directory for screenshots (default CWD)' },
  ],
  columns: ['symbol', 'close', 'change_pct', 'zscore', 'anomaly', 'bars', 'shot'],
  func: async (page, kwargs) => {
    const symbols = String(kwargs.symbols ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeSymbol);
    if (symbols.length === 0) throw new ArgumentError('scan requires at least one symbol', 'Example: tradingview scan "NASDAQ:AAPL,600519"');

    await ensureChart(page);

    const res = kwargs.interval ? normalizeInterval(String(kwargs.interval)) : null;
    const win = Math.max(3, Number(kwargs.lookback ?? 30));
    const zThresh = Number(kwargs['z-threshold'] ?? 2);
    const captureRaw = kwargs.capture;
    const capture = !!captureRaw && String(captureRaw) !== 'false';
    const outDir = String(kwargs['out-dir'] ?? '.').replace(/[\\/]+$/, '');

    // Remember the original symbol so we can restore the tab afterwards.
    const original = await page.evaluate<string>('window.TradingViewApi.activeChart().symbol()');

    const rows: Array<Record<string, unknown>> = [];
    try {
      for (const sym of symbols) {
        const expr = `new Promise((resolve) => {
          const c = window.TradingViewApi.activeChart();
          const SYM = ${jsLit(sym)};
          const RES = ${jsLit(res)};
          const WIN = ${jsLit(win)};
          let done = false;
          const finish = (obj) => { if (done) return; done = true; resolve(JSON.stringify(obj)); };
          const read = () => {
            try {
              const series = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
              const li = series.lastIndex();
              const fi = series.firstIndex();
              if (li == null || fi == null || li <= fi) return finish({ symbol: c.symbol(), error: 'no-bars' });
              const last = series.valueAt(li);
              const close = last ? last[4] : null;
              const prevBar = (li - 1 >= fi) ? series.valueAt(li - 1) : null;
              const prev = prevBar ? prevBar[4] : null;
              const changePct = (prev && close != null) ? ((close - prev) / prev) * 100 : null;
              const n = Math.min(WIN, li - fi);
              const rets = [];
              for (let i = li - n + 1; i <= li; i++) {
                const a = series.valueAt(i - 1), b = series.valueAt(i);
                if (a && b && a[4]) rets.push((b[4] - a[4]) / a[4]);
              }
              let z = null;
              if (rets.length > 2) {
                const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
                const variance = rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / rets.length;
                const std = Math.sqrt(variance);
                const latest = rets[rets.length - 1];
                z = std > 0 ? (latest - mean) / std : 0;
              }
              finish({ symbol: c.symbol(), close: close, prev: prev, changePct: changePct, z: z, bars: li - fi + 1 });
            } catch (e) { finish({ symbol: SYM, error: e.message }); }
          };
          const afterSym = () => { if (RES) { try { c.setResolution(RES, () => setTimeout(read, 500)); } catch (e) { setTimeout(read, 500); } setTimeout(read, 3000); } else { setTimeout(read, 500); } };
          try { c.setSymbol(SYM, afterSym); } catch (e) { return finish({ symbol: SYM, error: e.message }); }
          setTimeout(read, 6000);
        })`;
        const raw = await page.evaluate<string>(expr);
        const r = JSON.parse(raw) as {
          symbol: string;
          close?: number | null;
          changePct?: number | null;
          z?: number | null;
          bars?: number;
          error?: string;
        };

        let shot = '';
        if (capture && !r.error) {
          const safeSym = (r.symbol || sym).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          const path = `${outDir}/tv-${safeSym || 'chart'}-${Math.floor(Date.now() / 1000)}.png`;
          try {
            // screenshot() returns base64 and writes the file when path is set; report path.
            await page.screenshot({ path, format: 'png' });
            shot = path;
          } catch (e) {
            shot = `ERR:${(e as Error).message}`;
          }
        }

        const z = r.z ?? null;
        rows.push({
          symbol: r.symbol || sym,
          close: r.error ? `ERR:${r.error}` : r.close ?? null,
          change_pct: r.changePct != null ? Number(r.changePct.toFixed(3)) : null,
          zscore: z != null ? Number(z.toFixed(2)) : null,
          anomaly: z != null && Math.abs(z) >= zThresh ? 'yes' : '',
          bars: r.bars ?? 0,
          shot,
        });
      }
    } finally {
      // Restore the original symbol no matter what.
      if (original) {
        await page.evaluate<unknown>(
          `new Promise((r) => { try { window.TradingViewApi.activeChart().setSymbol(${jsLit(original)}, () => r(1)); setTimeout(() => r(1), 4000); } catch (e) { r(1); } })`,
        );
      }
    }

    return rows;
  },
});

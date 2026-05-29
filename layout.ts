import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, jsLit } from './_helpers.js';

// List / load the account's saved chart layouts via the Charting-Library API:
//   list -> window.TradingViewApi.getSavedCharts(cb)   -> [{id, name, pro_symbol, resolution, ...}]
//   load -> find a saved chart by --id or --name, then loadChartFromServer(record)
//
// getSavedCharts is callback-based; we wrap it in a Promise (openCLI eval awaits it)
// with a timeout fallback. load resolves the record itself so the caller never has to
// reconstruct the (large) saved-chart object.

const ACTIONS = ['list', 'load'] as const;

cli({
  site: 'tradingview',
  name: 'layout',
  description: 'List/load saved chart layouts on the bound TradingView account',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'list', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    { name: 'id', help: 'saved-chart id (for load)' },
    { name: 'name', help: 'saved-chart name (for load, alternative to --id)' },
  ],
  columns: ['id', 'name', 'symbol', 'resolution'],
  func: async (page, kwargs) => {
    const action = String(kwargs.action ?? 'list');
    await ensureChart(page);

    if (action === 'list') {
      const raw = await page.evaluate<string>(`new Promise((resolve) => {
        try {
          window.TradingViewApi.getSavedCharts((records) => resolve(JSON.stringify(records || [])));
        } catch (e) { return resolve('[]'); }
        setTimeout(() => resolve('[]'), 5000);
      })`);
      const records = JSON.parse(raw) as Array<Record<string, unknown>>;
      return records.map((r) => ({
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        symbol: String(r.pro_symbol ?? r.symbol ?? ''),
        resolution: String(r.resolution ?? ''),
      }));
    }

    // load
    const id = kwargs.id ? String(kwargs.id) : '';
    const name = kwargs.name ? String(kwargs.name) : '';
    if (!id && !name) throw new ArgumentError('layout load requires --id or --name', 'List them via: tradingview layout list');

    const raw = await page.evaluate<string>(`new Promise((resolve) => {
      const api = window.TradingViewApi;
      const ID = ${jsLit(id)};
      const NAME = ${jsLit(name)};
      try {
        api.getSavedCharts((records) => {
          records = records || [];
          let rec = null;
          if (ID) rec = records.find((r) => String(r.id) === ID);
          else if (NAME) rec = records.find((r) => r.name === NAME || r.short_name === NAME);
          if (!rec) return resolve(JSON.stringify({ error: 'not-found', count: records.length }));
          try { api.loadChartFromServer(rec); } catch (e) { return resolve(JSON.stringify({ error: e.message })); }
          resolve(JSON.stringify({ loaded: { id: rec.id, name: rec.name, symbol: rec.pro_symbol || rec.symbol, resolution: rec.resolution } }));
        });
      } catch (e) { return resolve(JSON.stringify({ error: e.message })); }
      setTimeout(() => resolve(JSON.stringify({ error: 'timeout' })), 6000);
    })`);
    const out = JSON.parse(raw) as { error?: string; count?: number; loaded?: { id: unknown; name: unknown; symbol: unknown; resolution: unknown } };
    if (out.error) {
      const hint = out.error === 'not-found' ? `No saved chart matched (searched ${out.count} layouts).` : 'Try again or check the chart API.';
      throw new ArgumentError(`layout load failed: ${out.error}`, hint);
    }
    const l = out.loaded!;
    return [{ id: String(l.id ?? ''), name: String(l.name ?? ''), symbol: String(l.symbol ?? ''), resolution: String(l.resolution ?? '') }];
  },
});

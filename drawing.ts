import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, jsLit } from './_helpers.js';

// Manage drawings (shapes) on the bound chart via the Charting-Library widget API:
//   list      -> activeChart().getAllShapes()
//   hline     -> activeChart().createShape({time, price}, {shape:'horizontal_line'})
//   trendline -> activeChart().createMultipointShape([{t,p},{t,p}], {shape:'trend_line'})
//   remove    -> activeChart().removeEntity(id)
//   clear     -> remove every shape returned by getAllShapes()
//
// getAllShapes() returns either [{id,name}] or bare id strings depending on the TV
// build, so we normalise both forms. Times are Unix SECONDS; --points is "t1,p1,t2,p2".

const ACTIONS = ['list', 'hline', 'trendline', 'remove', 'clear'] as const;

cli({
  site: 'tradingview',
  name: 'drawing',
  description: 'List/draw/remove/clear chart drawings (horizontal lines, trendlines) on the bound chart',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'list', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    { name: 'price', help: 'price level (required for hline)' },
    { name: 'points', help: 'trendline points "t1,p1,t2,p2" (Unix seconds, price)' },
    { name: 'id', help: 'entity id (required for remove)' },
  ],
  columns: ['action', 'id', 'detail'],
  func: async (page, kwargs) => {
    const action = String(kwargs.action ?? 'list');
    await ensureChart(page);

    if (action === 'list') {
      const raw = await page.evaluate<string>(
        'JSON.stringify(window.TradingViewApi.activeChart().getAllShapes())',
      );
      const shapes = JSON.parse(raw) as Array<{ id: string; name?: string } | string>;
      return shapes.map((s) =>
        typeof s === 'string'
          ? { action: 'list', id: s, detail: '' }
          : { action: 'list', id: String(s.id), detail: s.name ?? '' },
      );
    }

    if (action === 'remove') {
      const id = kwargs.id ? String(kwargs.id) : '';
      if (!id) throw new ArgumentError('drawing remove requires --id', 'Get ids via: tradingview drawing list');
      await page.evaluate<unknown>(`window.TradingViewApi.activeChart().removeEntity(${jsLit(id)})`);
      return [{ action: 'remove', id, detail: '' }];
    }

    if (action === 'clear') {
      const raw = await page.evaluate<string>(`(() => {
        const c = window.TradingViewApi.activeChart();
        const shapes = c.getAllShapes() || [];
        let n = 0;
        for (const s of shapes) { try { c.removeEntity(typeof s === 'string' ? s : s.id); n++; } catch (e) {} }
        return JSON.stringify({ n });
      })()`);
      const { n } = JSON.parse(raw) as { n: number };
      return [{ action: 'clear', id: '', detail: `removed ${n}` }];
    }

    if (action === 'hline') {
      const price = Number(kwargs.price);
      if (!Number.isFinite(price)) throw new ArgumentError('drawing hline requires a finite --price', 'Example: tradingview drawing hline --price 3500');
      // createShape may return either an EntityId or a Promise<EntityId> depending on
      // the TV build, so normalise via Promise.resolve before stringifying the id.
      const raw = await page.evaluate<string>(`new Promise((resolve) => {
        try {
          const c = window.TradingViewApi.activeChart();
          const t = Math.floor(Date.now() / 1000);
          const ret = c.createShape({ time: t, price: ${jsLit(price)} }, { shape: 'horizontal_line' });
          Promise.resolve(ret).then((id) => resolve(JSON.stringify({ id: id != null ? String(id) : null })))
            .catch((e) => resolve(JSON.stringify({ error: (e && e.message) || String(e) })));
        } catch (e) { resolve(JSON.stringify({ error: e.message })); }
        setTimeout(() => resolve(JSON.stringify({ error: 'timeout' })), 6000);
      })`);
      const out = JSON.parse(raw) as { id?: string | null; error?: string };
      if (out.error) throw new ArgumentError(`createShape failed: ${out.error}`, 'Check the chart is loaded and the price is on-scale.');
      return [{ action: 'hline', id: out.id ?? '', detail: `price=${price}` }];
    }

    // trendline
    const ptsRaw = kwargs.points ? String(kwargs.points) : '';
    const nums = ptsRaw.split(',').map((x) => Number(x.trim()));
    if (nums.length !== 4 || nums.some((x) => !Number.isFinite(x))) {
      throw new ArgumentError('drawing trendline requires --points "t1,p1,t2,p2" (4 finite numbers)', 'Times are Unix seconds. Example: --points "1716800000,3400,1716886400,3600"');
    }
    const [t1, p1, t2, p2] = nums;
    const raw = await page.evaluate<string>(`new Promise((resolve) => {
      try {
        const c = window.TradingViewApi.activeChart();
        const ret = c.createMultipointShape(
          [{ time: ${jsLit(t1)}, price: ${jsLit(p1)} }, { time: ${jsLit(t2)}, price: ${jsLit(p2)} }],
          { shape: 'trend_line' },
        );
        Promise.resolve(ret).then((id) => resolve(JSON.stringify({ id: id != null ? String(id) : null })))
          .catch((e) => resolve(JSON.stringify({ error: (e && e.message) || String(e) })));
      } catch (e) { resolve(JSON.stringify({ error: e.message })); }
      setTimeout(() => resolve(JSON.stringify({ error: 'timeout' })), 6000);
    })`);
    const out = JSON.parse(raw) as { id?: string | null; error?: string };
    if (out.error) throw new ArgumentError(`createMultipointShape failed: ${out.error}`, 'Times are Unix seconds and must fall within the loaded chart range.');
    return [{ action: 'trendline', id: out.id ?? '', detail: `(${t1},${p1})->(${t2},${p2})` }];
  },
});

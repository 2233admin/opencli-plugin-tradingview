import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, jsLit } from './_helpers.js';

// Manage studies (indicators) on the bound chart via the Charting-Library widget API:
//   list   -> activeChart().getAllStudies()    -> [{id, name}]
//   add    -> activeChart().createStudy(name, false, false, inputs, cb)  (Promise-wrapped)
//   remove -> activeChart().removeEntity(id)
//   clear  -> activeChart().removeAllStudies()
//
// Study NAMES are the Charting-Library names, e.g.:
//   "Moving Average", "Moving Average Exponential", "Relative Strength Index",
//   "MACD", "Bollinger Bands", "Volume", "Stochastic", "Average True Range".
// --inputs is a JSON array of the study's input values, e.g. RSI length: --inputs "[21]".

const ACTIONS = ['list', 'add', 'remove', 'clear'] as const;

cli({
  site: 'tradingview',
  name: 'indicator',
  description: 'List/add/remove/clear chart studies (indicators) on the bound chart',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'list', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    { name: 'name', help: 'study name (required for add), e.g. "Relative Strength Index"' },
    { name: 'id', help: 'entity id (required for remove)' },
    { name: 'inputs', help: 'JSON array of study inputs, e.g. "[21]" (add only)' },
  ],
  columns: ['action', 'id', 'name'],
  func: async (page, kwargs) => {
    const action = String(kwargs.action ?? 'list');
    await ensureChart(page);

    if (action === 'list') {
      const raw = await page.evaluate<string>(
        'JSON.stringify(window.TradingViewApi.activeChart().getAllStudies())',
      );
      const studies = JSON.parse(raw) as Array<{ id: string; name: string }>;
      return studies.map((s) => ({ action: 'list', id: String(s.id), name: s.name }));
    }

    if (action === 'clear') {
      await page.evaluate<unknown>('window.TradingViewApi.activeChart().removeAllStudies()');
      return [{ action: 'clear', id: '', name: '' }];
    }

    if (action === 'remove') {
      const id = kwargs.id ? String(kwargs.id) : '';
      if (!id) throw new ArgumentError('indicator remove requires --id', 'Get ids via: tradingview indicator list');
      await page.evaluate<unknown>(`window.TradingViewApi.activeChart().removeEntity(${jsLit(id)})`);
      return [{ action: 'remove', id, name: '' }];
    }

    // add
    const name = kwargs.name ? String(kwargs.name) : '';
    if (!name) throw new ArgumentError('indicator add requires --name', 'Example: --name "Relative Strength Index" --inputs "[21]"');
    let inputs: unknown[] | null = null;
    if (kwargs.inputs) {
      try {
        const parsed = JSON.parse(String(kwargs.inputs));
        if (!Array.isArray(parsed)) throw new Error('not an array');
        inputs = parsed;
      } catch (e) {
        throw new ArgumentError(`--inputs must be a JSON array: ${(e as Error).message}`, 'Example: --inputs "[21]"');
      }
    }

    // createStudy(name, forceOverlay, lock, inputs, overrides?, options?) returns
    // Promise<EntityId|null>. The 5th arg is an overrides OBJECT, not a callback —
    // passing a function there makes the study fail silently. Drive it off the Promise.
    const expr = `new Promise((resolve) => {
      const c = window.TradingViewApi.activeChart();
      const NAME = ${jsLit(name)};
      const INPUTS = ${jsLit(inputs)};
      let done = false;
      const finish = (obj) => { if (done) return; done = true; resolve(JSON.stringify(obj)); };
      try {
        const ret = c.createStudy(NAME, false, false, INPUTS || undefined);
        if (ret && typeof ret.then === 'function') {
          ret.then((id) => finish({ id: id != null ? String(id) : null }))
             .catch((e) => finish({ error: (e && e.message) || String(e) }));
        } else {
          finish({ id: ret != null ? String(ret) : null });
        }
      } catch (e) { return finish({ error: e.message }); }
      setTimeout(() => finish({ error: 'timeout' }), 12000);
    })`;
    const raw = await page.evaluate<string>(expr);
    const out = JSON.parse(raw) as { id?: string | null; error?: string };
    if (out.error) {
      throw new ArgumentError(`createStudy failed: ${out.error}`, 'Check the study name matches a TradingView indicator exactly (e.g. "Relative Strength Index", "Moving Average Exponential").');
    }
    return [{ action: 'add', id: out.id ?? '', name }];
  },
});

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
//
// PINE LOAD (open-source/community scripts) -- `add --pine <scriptIdPart>`:
//   createStudy(name) only resolves BUILT-IN studies by display name; community
//   Pine ("unexpected study id"). The internal path that loads ANY public Pine by
//   its scriptIdPart ("PUB;<hash>"), unattended, with no saved layout:
//     repo = activeChart().studyMetaIntoRepository(); await repo.requestMetaInfo();
//     mi = await repo.findById({ type:'pine', pineId:'PUB;<hash>', pineVersion:'last' })
//       -> _compilePine -> translateScriptAsync2(pineId, version): server compile,
//          returns full metaInfo. Works for any public script id, loaded or not.
//     model = api._activeChartWidgetWV.value()._chartWidget.model();
//     model._insertStudy(mi, false, false, inputs|[])  -> inserts it, allocates a
//       REAL entity id (insertStudyWithoutCheck leaves id empty -> not removable).
//   getAllStudies() then lists it and `readings` reads its plotted values.

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
    { name: 'pine', help: 'open-source/community Pine scriptIdPart to load (add only), e.g. "PUB;<hash>" — loads any public script by id, no saved layout needed' },
    { name: 'pine-version', help: 'Pine script version for --pine (default "last")' },
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
    const pine = kwargs.pine ? String(kwargs.pine) : '';
    const name = kwargs.name ? String(kwargs.name) : '';
    if (!pine && !name) throw new ArgumentError('indicator add requires --name or --pine', 'Built-in: --name "Relative Strength Index" --inputs "[21]"  |  Community Pine: --pine "PUB;<hash>"');
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

    // add --pine: load an open-source/community Pine script by its scriptIdPart.
    // createStudy(name) can't (built-in display names only). Resolve metaInfo from
    // the server via the study repository, then insert via the model. Works for any
    // public script id whether or not it's already on the chart or owned by the user.
    if (pine) {
      const version = kwargs['pine-version'] ? String(kwargs['pine-version']) : 'last';
      const expr = `new Promise((resolve) => {
        const finish = (o) => resolve(JSON.stringify(o));
        (async () => {
          try {
            const api = window.TradingViewApi;
            const chart = api.activeChart();
            const repo = chart.studyMetaIntoRepository();
            await repo.requestMetaInfo();
            const mi = await repo.findById({ type: 'pine', pineId: ${jsLit(pine)}, pineVersion: ${jsLit(version)} });
            if (!mi) return finish({ error: 'no metaInfo resolved for ' + ${jsLit(pine)} });
            const model = api._activeChartWidgetWV.value()._chartWidget.model();
            const before = new Set(chart.getAllStudies().map((s) => String(s.id)));
            model._insertStudy(mi, false, false, ${jsLit(inputs)} || []);
            // _insertStudy allocates the entity id ASYNCHRONOUSLY: right after the
            // call getAllStudies() shows the new study with an empty id, which
            // settles to a real id a tick later. Poll until a new study with a
            // non-empty id appears (~5s) so the caller gets a removable id.
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            let a = null;
            for (let i = 0; i < 50; i++) {
              const added = chart.getAllStudies().map((s) => ({ id: String(s.id), name: s.name })).filter((s) => !before.has(s.id));
              const real = added.find((s) => s.id && s.id !== '');
              if (real) { a = real; break; }
              await sleep(100);
            }
            if (!a) a = { id: null, name: mi.shortDescription || ${jsLit(pine)} };
            finish({ id: a.id, name: a.name || mi.shortDescription || ${jsLit(pine)} });
          } catch (e) { finish({ error: (e && e.message) || String(e) }); }
        })();
        setTimeout(() => finish({ error: 'timeout' }), 20000);
      })`;
      const raw = await page.evaluate<string>(expr);
      const out = JSON.parse(raw) as { id?: string | null; name?: string; error?: string };
      if (out.error) {
        throw new ArgumentError(`pine load failed: ${out.error}`, 'Check the scriptIdPart is a valid public script, e.g. "PUB;<hash>". Find it in the script\'s TradingView URL or via the chart it was published from.');
      }
      return [{ action: 'add', id: out.id ?? '', name: out.name ?? pine }];
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

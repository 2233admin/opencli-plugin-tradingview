import { cli, Strategy } from '@jackwener/opencli/registry';
import { TRADINGVIEW_DOMAIN, ensureChart, jsLit } from './_helpers.js';

// Read the CURRENT plotted values of the studies (indicators) loaded on the chart.
// This is how you "analyse" an open-source / community Pine indicator that is already
// on the chart: createStudy can only ADD built-in studies by display name, but ANY
// loaded study (including community Pine scripts brought in via a saved layout)
// exposes its computed output through the internal model.
//
// Reader path (validated):
//   model.dataSources() -> each study source
//   study.metaInfo()    -> { plots:[{id,type,...}], styles:{plotId:{title}}, shortDescription }
//   study.data().last() -> { index, value:[time, plot_0, plot_1, ...] }
//     value[0] is the bar time; value[i+1] is the value of metaInfo().plots[i].
//   (study.lastValueData() returns {noData:true} and study.valueAt() returns null on this
//    build — data().last() is the reliable reader.)
//
// One row per (study, named plot). Colorer/unnamed internal plots are skipped unless
// --all-plots is passed. Filter to a single study with --id (matches study id OR a
// substring of its title/short name).

cli({
  site: 'tradingview',
  name: 'readings',
  description: 'Read current plotted values of loaded chart studies (built-in or open-source indicators)',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'id', help: 'only read studies whose id or name contains this substring' },
    { name: 'all-plots', help: 'include colorer/unnamed internal plots too (flag)' },
  ],
  columns: ['study', 'id', 'plot', 'value', 'time'],
  func: async (page, kwargs) => {
    await ensureChart(page);
    const filter = kwargs.id ? String(kwargs.id) : '';
    const allPlotsRaw = kwargs['all-plots'];
    const allPlots = !!allPlotsRaw && String(allPlotsRaw) !== 'false';

    const expr = `(() => {
      const safe = (fn, d) => { try { return fn(); } catch (e) { return d; } };
      try {
        const model = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model();
        const sources = model.dataSources();
        const FILTER = ${jsLit(filter)};
        const ALL = ${jsLit(allPlots)};
        const fl = FILTER ? FILTER.toLowerCase() : '';
        const out = [];
        for (const s of sources) {
          const mi = safe(() => (typeof s.metaInfo === 'function' ? s.metaInfo() : null), null);
          if (!mi || !Array.isArray(mi.plots)) continue;             // not a study
          const title = safe(() => s.title(), '');
          const sid = safe(() => String(typeof s.sourceId === 'function' ? s.sourceId() : ''), '');
          const shortName = mi.shortDescription || (title ? title.split(' (')[0] : '') || mi.description || '';
          if (fl && title.toLowerCase().indexOf(fl) === -1 && sid.toLowerCase().indexOf(fl) === -1) continue;
          const last = safe(() => { const d = s.data(); return d && typeof d.last === 'function' ? d.last() : null; }, null);
          if (!last || !Array.isArray(last.value)) continue;          // no numeric data (pure-drawing study)
          const styles = mi.styles || {};
          const time = last.value[0];
          for (let i = 0; i < mi.plots.length; i++) {
            const p = mi.plots[i];
            const st = styles[p.id];
            const plotTitle = st && st.title;
            const isColorer = p.type === 'colorer';
            if (!ALL && (isColorer || !plotTitle)) continue;
            if (!ALL && st && st.isHidden) continue;
            const v = last.value[i + 1];
            out.push({
              study: shortName,
              id: sid,
              plot: plotTitle || p.id,
              value: (v === null || v === undefined) ? null : v,
              time: time,
            });
          }
        }
        return JSON.stringify({ ok: true, rows: out });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    })()`;

    const raw = await page.evaluate<string>(expr);
    const parsed = JSON.parse(raw) as
      | { ok: true; rows: Array<{ study: string; id: string; plot: string; value: number | null; time: number }> }
      | { ok: false; error: string };
    if (!parsed.ok) {
      return [{ study: '', id: '', plot: 'ERROR', value: null, time: parsed.error as unknown as number }];
    }
    return parsed.rows;
  },
});

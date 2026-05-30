import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, jsLit } from './_helpers.js';

// Manage drawings (shapes) on the bound chart via the Charting-Library widget API:
//   list      -> activeChart().getAllShapes()  (returns [{id,name}])
//   hline     -> activeChart().createShape({time,price}, {shape:'horizontal_line'})  (convenience)
//   trendline -> activeChart().createMultipointShape([p1,p2], {shape:'trend_line'})  (convenience)
//   shape     -> generic: any confirmed shape via --shape + --points (+ --text)
//   remove    -> activeChart().removeEntity(id)
//   clear     -> activeChart().removeAllShapes()
//   save      -> TradingViewApi.saveChartToServer() — persist chart+drawings to the saved layout
//
// SHAPE catalog below was probed live against the running TV build (createShape for
// 1-point, createMultipointShape for >=2). Times are Unix SECONDS; --points is a flat
// comma list "t1,p1,t2,p2,..." with one (time,price) pair per required point.
// text/note/anchored_note require --text. getAllShapes() may return [{id,name}] or bare
// id strings depending on build, so we normalise both forms.
//
// Persistence: drawings live in chart memory and vanish on reload UNLESS persisted. Run
// `tradingview drawing save` (or pass --save to hline/trendline/shape) to write them into
// the named layout so an unattended agent's marks survive across sessions.

const ACTIONS = ['list', 'hline', 'trendline', 'shape', 'remove', 'clear', 'save'] as const;

// shape -> required (time,price) point count; text:true means --text is mandatory.
const SHAPE_SPECS: Record<string, { points: number; text?: boolean }> = {
  horizontal_line: { points: 1 },
  vertical_line: { points: 1 },
  horizontal_ray: { points: 1 },
  extended_line: { points: 1 },
  text: { points: 1, text: true },
  note: { points: 1, text: true },
  anchored_note: { points: 1, text: true },
  trend_line: { points: 2 },
  ray: { points: 2 },
  rectangle: { points: 2 },
  fib_retracement: { points: 2 },
  price_range: { points: 2 },
  date_range: { points: 2 },
  date_and_price_range: { points: 2 },
  info_line: { points: 2 },
  parallel_channel: { points: 3 },
};
const SHAPE_NAMES = Object.keys(SHAPE_SPECS);

// Parse "t1,p1,t2,p2,..." into [{time,price}] pairs; throws on bad input.
function parsePoints(raw: string, expectedPairs: number): Array<{ time: number; price: number }> {
  const nums = String(raw ?? '')
    .split(',')
    .map((x) => Number(x.trim()));
  if (nums.length !== expectedPairs * 2 || nums.some((x) => !Number.isFinite(x))) {
    throw new ArgumentError(
      `expected ${expectedPairs} point(s) = ${expectedPairs * 2} finite numbers in --points "t1,p1,..."`,
      `Got ${nums.length} number(s). Times are Unix seconds. Example for 2 points: --points "1716800000,3400,1716886400,3600"`,
    );
  }
  const pts: Array<{ time: number; price: number }> = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ time: nums[i], price: nums[i + 1] });
  return pts;
}

// Build the JS literal for a points array.
function pointsLit(pts: Array<{ time: number; price: number }>): string {
  return '[' + pts.map((p) => `{ time: ${jsLit(p.time)}, price: ${jsLit(p.price)} }`).join(', ') + ']';
}

// Create a shape via the widget API; resolves {id} or {error}. Handles sync-id or
// Promise<id> returns across TV builds. Used by hline/trendline/shape.
async function createShape(
  page: any,
  call: string,
): Promise<{ id?: string | null; error?: string }> {
  const raw = await page.evaluate<string>(`new Promise((resolve) => {
    try {
      const c = window.TradingViewApi.activeChart();
      const ret = ${call};
      Promise.resolve(ret)
        .then((id) => resolve(JSON.stringify({ id: id != null ? String(id) : null })))
        .catch((e) => resolve(JSON.stringify({ error: (e && e.message) || String(e) })));
    } catch (e) { resolve(JSON.stringify({ error: (e && e.message) || String(e) })); }
    setTimeout(() => resolve(JSON.stringify({ error: 'timeout' })), 6000);
  })`);
  return JSON.parse(raw);
}

// Persist current chart (incl. drawings) into the saved layout. Resolves {ok}/{error}.
async function saveChart(page: any): Promise<{ ok: boolean; error?: string }> {
  const raw = await page.evaluate<string>(`new Promise((resolve) => {
    try {
      const api = window.TradingViewApi;
      if (typeof api.saveChartToServer !== 'function') { resolve(JSON.stringify({ ok: false, error: 'saveChartToServer unavailable' })); return; }
      api.saveChartToServer(
        () => resolve(JSON.stringify({ ok: true })),
        (e) => resolve(JSON.stringify({ ok: false, error: (e && e.message) || String(e) })),
      );
    } catch (e) { resolve(JSON.stringify({ ok: false, error: (e && e.message) || String(e) })); }
    setTimeout(() => resolve(JSON.stringify({ ok: false, error: 'timeout' })), 12000);
  })`);
  return JSON.parse(raw);
}

cli({
  site: 'tradingview',
  name: 'drawing',
  description: 'List/draw/remove/clear/save chart drawings (lines, trendlines, rectangles, fib, text, channels) on the bound chart',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'list', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    { name: 'shape', help: `shape (for action=shape): ${SHAPE_NAMES.join('|')}` },
    { name: 'price', help: 'price level (required for hline)' },
    { name: 'points', help: 'flat "t1,p1,t2,p2,..." (Unix seconds, price) — for trendline/shape' },
    { name: 'text', help: 'label text (required for shape=text|note|anchored_note)' },
    { name: 'id', help: 'entity id (required for remove)' },
    { name: 'save', type: 'boolean', default: false, help: 'persist to the layout after drawing' },
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
      if (shapes.length === 0) return [{ action: 'list', id: '', detail: '(no drawings)' }];
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
        const before = (c.getAllShapes() || []).length;
        try { c.removeAllShapes(); } catch (e) {
          for (const s of (c.getAllShapes() || [])) { try { c.removeEntity(typeof s === 'string' ? s : s.id); } catch (e2) {} }
        }
        return JSON.stringify({ n: before });
      })()`);
      const { n } = JSON.parse(raw) as { n: number };
      return [{ action: 'clear', id: '', detail: `removed ${n}` }];
    }

    if (action === 'save') {
      const res = await saveChart(page);
      if (!res.ok) throw new ArgumentError(`drawing save failed: ${res.error}`, 'Confirm the chart is a saved layout and you are signed in.');
      return [{ action: 'save', id: '', detail: 'persisted to layout' }];
    }

    const wantSave = kwargs.save === true || String(kwargs.save ?? '').toLowerCase() === 'yes';
    const maybeSave = async (detail: string) => {
      if (!wantSave) return detail;
      const res = await saveChart(page);
      return res.ok ? `${detail} (saved)` : `${detail} (save failed: ${res.error})`;
    };

    if (action === 'hline') {
      const price = Number(kwargs.price);
      if (!Number.isFinite(price)) throw new ArgumentError('drawing hline requires a finite --price', 'Example: tradingview drawing hline --price 3500');
      const out = await createShape(
        page,
        `c.createShape({ time: Math.floor(Date.now() / 1000), price: ${jsLit(price)} }, { shape: 'horizontal_line' })`,
      );
      if (out.error) throw new ArgumentError(`createShape failed: ${out.error}`, 'Check the chart is loaded and the price is on-scale.');
      return [{ action: 'hline', id: out.id ?? '', detail: await maybeSave(`price=${price}`) }];
    }

    if (action === 'trendline') {
      const pts = parsePoints(kwargs.points ? String(kwargs.points) : '', 2);
      const out = await createShape(page, `c.createMultipointShape(${pointsLit(pts)}, { shape: 'trend_line' })`);
      if (out.error) throw new ArgumentError(`createMultipointShape failed: ${out.error}`, 'Times are Unix seconds and must fall within the loaded chart range.');
      const [a, b] = pts;
      return [{ action: 'trendline', id: out.id ?? '', detail: await maybeSave(`(${a.time},${a.price})->(${b.time},${b.price})`) }];
    }

    // generic shape
    const shape = kwargs.shape ? String(kwargs.shape).trim() : '';
    const spec = SHAPE_SPECS[shape];
    if (!spec) {
      throw new ArgumentError(
        `drawing shape requires a known --shape`,
        `Valid: ${SHAPE_NAMES.join(', ')}. Example: tradingview drawing shape --shape rectangle --points "1716800000,3400,1716886400,3600"`,
      );
    }
    const text = kwargs.text != null ? String(kwargs.text) : '';
    if (spec.text && !text) {
      throw new ArgumentError(`drawing shape --shape ${shape} requires --text`, `Example: tradingview drawing shape --shape text --points "1716800000,3500" --text "key level"`);
    }
    const pts = parsePoints(kwargs.points ? String(kwargs.points) : '', spec.points);
    const opts = spec.text ? `{ shape: ${jsLit(shape)}, text: ${jsLit(text)} }` : `{ shape: ${jsLit(shape)} }`;
    const call =
      spec.points === 1
        ? `c.createShape({ time: ${jsLit(pts[0].time)}, price: ${jsLit(pts[0].price)} }, ${opts})`
        : `c.createMultipointShape(${pointsLit(pts)}, ${opts})`;
    const out = await createShape(page, call);
    if (out.error) throw new ArgumentError(`create ${shape} failed: ${out.error}`, 'Times are Unix seconds within the loaded range; price must be on-scale.');
    const detail = `${shape} ${pts.map((p) => `(${p.time},${p.price})`).join('->')}${text ? ` "${text}"` : ''}`;
    return [{ action: 'shape', id: out.id ?? '', detail: await maybeSave(detail) }];
  },
});

import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, normalizeSymbol, jsLit } from './_helpers.js';

// Drive the connected broker's order API via the Charting-Library Trading widget:
//   window.TradingViewApi.waitTrading() -> Promise<tradingController t>
//   t.connectStatus  -> WatchedValue|fn  (1=Connected 2=Connecting 3=NotConnected)
//   t.activeBroker() -> brokerController  (placeOrder/cancelOrder/closePosition/...)
//
// Ground-truth probed live against a CONNECTED Paper Trading broker (OKX:ETHUSD):
//   - waitTrading() returns a PROMISE; await it.
//   - connectStatus is a WatchedValue|fn -> unwrap with .value().
//   - orders()/positions() return a PROMISE that resolves to an ARRAY (await them; they
//     are NOT WatchedValues). A filled market order shows up in positions(), a resting
//     limit order in orders(). symbolInfo()/accountMetainfo()/accountManagerInfo() are
//     likewise Promises -> await before reading.
//   - placeOrder(order) -> Promise; cancelOrder(id) -> Promise; both resolve truthy.
//   - previewOrder(order) -> Promise<{sections:[{rows:[{title,value}]}]}>  (NON-committal,
//     safe to call — never sends an order). Used as the default dry-run for `place`.
//   - Order object shape: {symbol, side, type, qty, limitPrice?, stopPrice?,
//     takeProfit?, stopLoss?}.  side: 1=buy -1=sell.  type: 1=limit 2=market.
//   - A working order reads back as: {id, symbol, side, type, status, qty, leverage,
//     limitPrice, duration, placingTime, ...}.
//   - OrderStatus enum: 1=Canceled 2=Filled 3=Inactive 4=Placing 5=Rejected 6=Working.
//     orders() returns ALL recent orders (incl. canceled/filled history), so filter to
//     status 4/6 to get truly LIVE working orders. A canceled order REMAINS in orders()
//     with status=1 — never treat "still listed" as "cancel failed".
//   - symbolInfo(sym).qty -> {min,max,step,default} for qty validation.
//   - accountMetainfo().type === 'demo' for Paper; a real broker is anything else.
//
// SAFETY MODEL (money-sensitive):
//   - `place` is PREVIEW-ONLY by default (previewOrder). Nothing is sent.
//   - `place --fire` sends a real order via placeOrder. On a DEMO/paper account that is
//     fake money and runs freely. On a REAL account it ALSO requires --confirm (a
//     per-order human gate) — without it the command refuses. This is deliberate: an
//     unattended agent must not move real funds without an explicit confirm each time.

const ACTIONS = ['account', 'positions', 'orders', 'place', 'cancel', 'close'] as const;
const SIDES = ['buy', 'sell'] as const;
const TYPES = ['limit', 'market'] as const;

// Eval `body` against the CONNECTED broker. Injects: api, t (tradingController),
// ab (activeBroker), wv (WatchedValue unwrapper). Refuses early if no broker is
// connected so callers get a clean, actionable error instead of a null deref.
// `body` must `return` a JSON-serialisable value. Timeout-guarded.
async function runBroker(page: any, body: string, timeoutMs = 15000): Promise<any> {
  const raw = await page.evaluate<string>(`new Promise((resolve) => {
    const wv = (x) => { try { return (x && typeof x.value === 'function') ? x.value() : x; } catch (e) { return null; } };
    (async () => {
      try {
        const api = window.TradingViewApi;
        const t = await Promise.resolve(api.waitTrading());
        const csRaw = typeof t.connectStatus === 'function' ? t.connectStatus() : t.connectStatus;
        const cs = wv(csRaw);
        if (cs !== 1) return resolve(JSON.stringify({ ok: false, error: 'not-connected', cs }));
        const ab = typeof t.activeBroker === 'function' ? t.activeBroker() : t.activeBroker;
        if (!ab) return resolve(JSON.stringify({ ok: false, error: 'no-broker' }));
        const r = await (async () => { ${body} })();
        resolve(JSON.stringify({ ok: true, r }));
      } catch (e) { resolve(JSON.stringify({ ok: false, error: (e && e.message) || String(e) })); }
    })();
    setTimeout(() => resolve(JSON.stringify({ ok: false, error: 'timeout' })), ${timeoutMs});
  })`);
  return JSON.parse(raw);
}

const NOT_CONNECTED_HINT =
  'Connect a broker ONCE in the TradingView UI (Trading panel -> pick a broker, e.g. Paper Trading -> Connect). ' +
  'A real human click is required to establish the session; after that this command works unattended on the persistent tab.';

function connErr(res: { error: string; cs?: number }): ArgumentError {
  if (res.error === 'not-connected') {
    return new ArgumentError(`no broker connected (connectStatus=${res.cs ?? '?'})`, NOT_CONNECTED_HINT);
  }
  if (res.error === 'no-broker') {
    return new ArgumentError('broker session present but activeBroker is null', NOT_CONNECTED_HINT);
  }
  return new ArgumentError(`broker call failed: ${res.error}`, 'Confirm the chart is loaded and a broker is connected.');
}

const sideStr = (s: any): string => (s === 1 ? 'buy' : s === -1 ? 'sell' : String(s ?? ''));
const typeStr = (t: any): string => (t === 1 ? 'limit' : t === 2 ? 'market' : t === 3 ? 'stop' : t === 4 ? 'stop-limit' : String(t ?? ''));
// OrderStatus enum (probed live): 1=canceled 2=filled 3=inactive 4=placing 5=rejected 6=working.
const STATUS: Record<number, string> = { 1: 'canceled', 2: 'filled', 3: 'inactive', 4: 'placing', 5: 'rejected', 6: 'working' };
const statusStr = (s: any): string => (typeof s === 'number' && STATUS[s] ? STATUS[s] : String(s ?? ''));
const arr = (x: any): any[] => (Array.isArray(x) ? x : []);
const num = (x: any): string => (x == null ? '' : String(x));

cli({
  site: 'tradingview',
  name: 'order',
  description: 'Read account/positions/orders and place/cancel/close orders on the connected broker. Preview-by-default; real fire is gated behind --fire (+ --confirm on real accounts).',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'account', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    { name: 'symbol', help: 'symbol (default: chart symbol). A-share auto-prefixed; crypto e.g. "OKX:ETHUSD"' },
    { name: 'side', help: `place: ${SIDES.join('|')}`, choices: [...SIDES] },
    { name: 'type', default: 'limit', help: `place: ${TYPES.join('|')} (default limit)`, choices: [...TYPES] },
    { name: 'qty', help: 'place: order quantity (validated against symbol min/step)' },
    { name: 'limit', help: 'place: limit price (required for type=limit)' },
    { name: 'stop', help: 'place: stop price (optional)' },
    { name: 'tp', help: 'place: take-profit price (optional)' },
    { name: 'sl', help: 'place: stop-loss price (optional)' },
    { name: 'id', help: 'cancel: order id (from `order orders`)' },
    { name: 'fire', type: 'boolean', default: false, help: 'place: actually SEND the order (default is preview only)' },
    { name: 'confirm', type: 'boolean', default: false, help: 'place --fire: required extra gate to send a REAL-money order' },
  ],
  columns: ['action', 'symbol', 'side', 'qty', 'price', 'detail'],
  func: async (page, kwargs) => {
    const action = String(kwargs.action ?? 'account');
    await ensureChart(page);

    if (action === 'account') {
      // accountManagerInfo().summary is an ARRAY of {text, wValue} where wValue is a
      // WatchedValue holding the live number. Flatten it to a label->value map.
      const res = await runBroker(
        page,
        `const meta = (typeof ab.accountMetainfo === 'function') ? wv(await Promise.resolve(ab.accountMetainfo())) : null;
         const info = (typeof ab.accountManagerInfo === 'function') ? wv(await Promise.resolve(ab.accountManagerInfo())) : null;
         const sm = (info && Array.isArray(info.summary)) ? info.summary : [];
         const vals = {};
         for (const it of sm) { try { vals[it.text] = wv(it.wValue); } catch (e) {} }
         return { meta: meta ? { id: meta.id, name: meta.name, type: meta.type, currency: meta.currency } : {}, vals };`,
      );
      if (!res.ok) throw connErr(res);
      const m = res.r.meta || {};
      const v = res.r.vals || {};
      const bal = v['Account balance'];
      const eq = v['Equity'];
      const avail = v['Available funds'];
      const detail = `type=${m.type ?? '?'} balance=${num(bal)} equity=${num(eq)} available=${num(avail)} upl=${num(v['Unrealized PnL'])} ${m.currency ?? ''}`.trim();
      return [{ action: 'account', symbol: String(m.id ?? m.name ?? ''), side: m.type ?? '', qty: num(bal), price: num(avail), detail }];
    }

    if (action === 'positions') {
      const res = await runBroker(page, `const x = await Promise.resolve(ab.positions()); return Array.isArray(x) ? x : [];`);
      if (!res.ok) throw connErr(res);
      // positions() can return flattened ghosts with qty=0; only show real open positions.
      const ps = arr(res.r).filter((p: any) => p.qty);
      if (!ps.length) return [{ action: 'positions', symbol: '', side: '', qty: '', price: '', detail: 'no open positions' }];
      return ps.map((p: any) => ({
        action: 'position', symbol: String(p.symbol ?? ''), side: sideStr(p.side), qty: num(p.qty),
        price: num(p.avgPrice ?? p.price), detail: `pl=${num(p.pl ?? p.unrealizedPL)}`,
      }));
    }

    if (action === 'orders') {
      const res = await runBroker(page, `const x = await Promise.resolve(ab.orders()); return Array.isArray(x) ? x : [];`);
      if (!res.ok) throw connErr(res);
      // orders() includes canceled/filled history; show only LIVE working/placing (status 6/4).
      const os = arr(res.r).filter((o: any) => o.status === 6 || o.status === 4);
      if (!os.length) return [{ action: 'orders', symbol: '', side: '', qty: '', price: '', detail: 'no working orders' }];
      return os.map((o: any) => ({
        action: 'order', symbol: String(o.symbol ?? ''), side: sideStr(o.side), qty: num(o.qty),
        price: num(o.limitPrice ?? o.stopPrice), detail: `id=${o.id} type=${typeStr(o.type)} status=${statusStr(o.status)}`,
      }));
    }

    if (action === 'cancel') {
      const id = kwargs.id ? String(kwargs.id) : '';
      if (!id) throw new ArgumentError('order cancel requires --id', 'List ids via: tradingview order orders');
      const res = await runBroker(
        page,
        // Poll (25ms) until the order leaves working/placing, instead of a fixed settle
        // wait — confirms cancel as fast as the broker reflects it (~0.3s typical, ~2s cap).
        `const r = await ab.cancelOrder(${jsLit(id)});
         let still = true;
         for (let k = 0; k < 80; k++) {
           const left = await Promise.resolve(ab.orders());
           const o = (Array.isArray(left) ? left : []).find((o) => String(o.id) === ${jsLit(id)});
           // A canceled order STAYS in orders() with status=1; it's only "still working" at status 6/4.
           still = !!(o && (o.status === 6 || o.status === 4));
           if (!still) break;
           await new Promise((res2) => setTimeout(res2, 25));
         }
         return { r: wv(r), still };`,
      );
      if (!res.ok) throw connErr(res);
      const detail = res.r.still ? `cancel sent, order ${id} still working (may settle shortly)` : `order ${id} cancelled`;
      return [{ action: 'cancel', symbol: '', side: '', qty: '', price: '', detail }];
    }

    if (action === 'close') {
      const sym = normalizeSymbol(String(kwargs.symbol ?? '') || (await page.evaluate<string>('window.TradingViewApi.activeChart().symbol()')));
      const res = await runBroker(
        page,
        `const poss = await Promise.resolve(ab.positions());
         const list = Array.isArray(poss) ? poss : [];
         const pos = list.find((p) => String(p.symbol) === ${jsLit(sym)});
         if (!pos) return { closed: false, reason: 'no open position for ' + ${jsLit(sym)} };
         const r = await ab.closePosition(pos.id != null ? pos.id : pos, undefined, undefined);
         // Poll (25ms) until the position is flat, instead of a fixed settle wait.
         let left = true;
         for (let k = 0; k < 80; k++) {
           const after = await Promise.resolve(ab.positions());
           // A flattened position can linger with qty=0; only a nonzero qty means still open.
           left = (Array.isArray(after) ? after : []).some((p) => String(p.symbol) === ${jsLit(sym)} && p.qty);
           if (!left) break;
           await new Promise((res2) => setTimeout(res2, 25));
         }
         return { closed: !left, r: wv(r) };`,
        18000,
      );
      if (!res.ok) throw connErr(res);
      if (res.r.reason) return [{ action: 'close', symbol: sym, side: '', qty: '', price: '', detail: res.r.reason }];
      return [{ action: 'close', symbol: sym, side: '', qty: '', price: '', detail: res.r.closed ? 'position closed' : 'close sent (still settling)' }];
    }

    // ---- place (preview by default; --fire to send) ----
    const sym = normalizeSymbol(String(kwargs.symbol ?? '') || (await page.evaluate<string>('window.TradingViewApi.activeChart().symbol()')));
    const sideRaw = kwargs.side ? String(kwargs.side) : '';
    if (sideRaw !== 'buy' && sideRaw !== 'sell') {
      throw new ArgumentError('order place requires --side buy|sell', 'Example: order place --side buy --type limit --qty 0.01 --limit 3000');
    }
    const side = sideRaw === 'buy' ? 1 : -1;
    const typeRaw = String(kwargs.type ?? 'limit');
    const type = typeRaw === 'market' ? 2 : 1;
    const qty = Number(kwargs.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ArgumentError('order place requires a positive --qty', 'Example: --qty 0.01');
    }
    const order: Record<string, unknown> = { symbol: sym, side, type, qty };
    if (type === 1) {
      const lp = Number(kwargs.limit);
      if (!Number.isFinite(lp) || lp <= 0) {
        throw new ArgumentError('limit order requires --limit <price>', 'Example: --type limit --limit 3000');
      }
      order.limitPrice = lp;
    }
    for (const [flag, key] of [['stop', 'stopPrice'], ['tp', 'takeProfit'], ['sl', 'stopLoss']] as const) {
      if (kwargs[flag] != null && String(kwargs[flag]).trim() !== '') {
        const v = Number(kwargs[flag]);
        if (!Number.isFinite(v) || v <= 0) throw new ArgumentError(`--${flag} must be a positive price`, `Example: --${flag} 3200`);
        order[key] = v;
      }
    }

    const fire = kwargs.fire === true;

    if (!fire) {
      // Dry-run: previewOrder is non-committal. Also pull symbol qty constraints so the
      // caller can sanity-check size before firing.
      const res = await runBroker(
        page,
        `const order = ${jsLit(order)};
         let si = null; try { si = wv(await Promise.resolve(ab.symbolInfo(order.symbol))); } catch (e) {}
         let pv = null, perr = null;
         try { pv = wv(await Promise.resolve(ab.previewOrder(order))); } catch (e) { perr = (e && e.message) || String(e); }
         return { preview: pv, perr, qtyInfo: si && si.qty ? si.qty : null };`,
      );
      if (!res.ok) throw connErr(res);
      const rows: Array<Record<string, string>> = [
        { action: 'preview', symbol: sym, side: sideRaw, qty: num(qty), price: num(order.limitPrice), detail: `type=${typeRaw} (PREVIEW — not sent; add --fire to send)` },
      ];
      const q = res.r.qtyInfo;
      if (q) rows.push({ action: 'preview', symbol: sym, side: '', qty: '', price: '', detail: `qty min=${num(q.min)} step=${num(q.step)} max=${num(q.max)}` });
      const pv = res.r.preview;
      const secs = pv && Array.isArray(pv.sections) ? pv.sections : [];
      for (const sec of secs) {
        for (const row of (sec.rows || [])) {
          rows.push({ action: 'preview', symbol: '', side: '', qty: '', price: '', detail: `${row.title}: ${row.value}` });
        }
      }
      if (res.r.perr) rows.push({ action: 'preview', symbol: '', side: '', qty: '', price: '', detail: `previewOrder error: ${res.r.perr}` });
      return rows;
    }

    // --fire: send the order. Demo accounts run freely; real accounts require --confirm.
    const confirm = kwargs.confirm === true;
    const res = await runBroker(
      page,
      `const order = ${jsLit(order)};
       const meta = (typeof ab.accountMetainfo === 'function') ? wv(await Promise.resolve(ab.accountMetainfo())) : null;
       const isDemo = !!(meta && meta.type === 'demo');
       if (!isDemo && !${jsLit(confirm)}) {
         return { blocked: true, isDemo, reason: 'real-account fire needs --confirm' };
       }
       const r = await ab.placeOrder(order);
       // Poll (25ms) until the order is observable as either a resting working order or a
       // filled position, instead of a fixed settle wait. Breaks as soon as one appears
       // (~0.3-0.5s typical); falls through after ~2s only if nothing landed (rejected).
       let oList = [], pList = [];
       for (let k = 0; k < 80; k++) {
         const ords = await Promise.resolve(ab.orders());
         const poss = await Promise.resolve(ab.positions());
         // Resting order = LIVE working/placing (status 6/4); filled order -> nonzero position.
         oList = (Array.isArray(ords) ? ords : []).filter((o) => String(o.symbol) === order.symbol && (o.status === 6 || o.status === 4));
         pList = (Array.isArray(poss) ? poss : []).filter((p) => String(p.symbol) === order.symbol && p.qty);
         if (oList.length || pList.length) break;
         await new Promise((res2) => setTimeout(res2, 25));
       }
       return { isDemo, place: wv(r), placedOrders: oList, placedPositions: pList };`,
      18000,
    );
    if (!res.ok) throw connErr(res);
    if (res.r.blocked) {
      throw new ArgumentError(
        'real-money order blocked: this is a LIVE account and --confirm was not supplied',
        'Re-run with --fire --confirm to send a real order. (Demo/paper accounts fire with --fire alone.)',
      );
    }
    const tag = res.r.isDemo ? 'PAPER' : 'LIVE';
    // A resting limit order lands in orders(); a filled market order lands in positions().
    const oList = arr(res.r.placedOrders);
    const resting = oList.length ? oList[oList.length - 1] : null;
    if (resting) {
      return [{
        action: 'placed', symbol: String(resting.symbol ?? sym), side: sideStr(resting.side), qty: num(resting.qty),
        price: num(resting.limitPrice ?? resting.stopPrice ?? order.limitPrice),
        detail: `${tag} resting id=${resting.id} type=${typeStr(resting.type)} status=${statusStr(resting.status)}`,
      }];
    }
    const pList = arr(res.r.placedPositions);
    const filled = pList.length ? pList[pList.length - 1] : null;
    if (filled) {
      return [{
        action: 'placed', symbol: String(filled.symbol ?? sym), side: sideStr(filled.side), qty: num(filled.qty),
        price: num(filled.avgPrice ?? order.limitPrice),
        detail: `${tag} FILLED -> position avgPrice=${num(filled.avgPrice)} pl=${num(filled.pl)}`,
      }];
    }
    return [{ action: 'placed', symbol: sym, side: sideRaw, qty: num(qty), price: num(order.limitPrice), detail: `${tag} placeOrder=${num(res.r.place)} but nothing resting/filled — may still be settling or was rejected` }];
  },
});

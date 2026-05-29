import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, normalizeSymbol, normalizeInterval } from './_helpers.js';

// Manage the price alerts on the logged-in account via TradingView's alert REST backend.
// This is the unattended-watch control surface: a server-side alert fires 24/7 even with
// no browser open, and (with a web_hook) POSTs to a downstream consumer the moment price
// crosses a level — the create -> fire -> webhook -> external-executor signal chain.
//
//   list   GET  https://pricealerts.tradingview.com/list_alerts            -> { s:'ok', r:[<alert>] }
//   create POST https://pricealerts.tradingview.com/create_alert           -> { s:'ok', r:{<alert>} }
//   delete POST https://pricealerts.tradingview.com/delete_alerts          -> { s:'ok' }
//
// All three are cookie-authenticated (sessionid is HttpOnly, auto-sent with
// credentials:'include'); there is no CSRF token. pricealerts.tradingview.com is
// cross-origin to www.tradingview.com, so the POST body MUST be sent as a plain string
// with NO explicit Content-Type: that defaults to text/plain (a CORS-safe request, no
// preflight). Adding Content-Type: application/json triggers an OPTIONS preflight that
// pricealerts rejects -> "Failed to fetch".
//
// Wire shapes confirmed by probe against the live endpoint (create/delete verified by a
// follow-up list, disposable non-firing alerts cleaned up):
//   create body: { payload: { conditions:[{ type, frequency:'on_first_fire',
//                  series:[{type:'barset'},{type:'value',value:<PRICE>}], resolution }],
//                  symbol:'='+JSON{ "currency-id", session:'regular', symbol },
//                  resolution, message, sound_file:null, sound_duration:0, popup:true,
//                  auto_deactivate:<bool>, email:false, sms_over_email:false,
//                  mobile_push:<bool>, web_hook:<url|null>, name:null, expiration:<ISO>,
//                  active:true, ignore_warnings:true } }
//   delete body: { payload: { alert_ids:[<id>, ...] } }
//
// Probed enum facts (anything outside these is rejected with err.code 'invalid_request'):
//   condition.type   : cross | cross_up | cross_down | greater | less
//                      (greater_equal / less_equal are NOT accepted)
//   condition.frequency: only 'on_first_fire' is accepted for a price condition
//                      (once_per_bar / once_per_bar_close / all / once_per_minute rejected).
//                      Recurrence is governed by auto_deactivate, NOT frequency:
//                        auto_deactivate:true  -> "Only Once" (fires once, then deactivates)
//                        auto_deactivate:false -> stays armed, re-fires on each subsequent cross
//   the plain symbol string ("OKX:ETHUSD") is rejected; the '='+JSON wrapper is required.

const ACTIONS = ['list', 'create', 'delete'] as const;
const CONDITIONS = ['cross', 'cross_up', 'cross_down', 'greater', 'less'] as const;

const PRICEALERTS = 'https://pricealerts.tradingview.com';

interface RawAlert {
  alert_id?: number;
  symbol?: string;
  pro_symbol?: string;
  active?: boolean;
  last_fire_time?: string | null;
  type?: string;
  resolution?: string;
  message?: string;
  web_hook?: string | null;
}

// Both symbol and pro_symbol arrive as `=` + JSON (e.g. ={"symbol":"BINANCE:LINKUSDT.P",...}).
// Strip the leading `=`, parse, and pull out the embedded ticker; fall back to the raw string.
function cleanSymbol(a: RawAlert): string {
  const raw = a.symbol ?? a.pro_symbol ?? '';
  const body = raw.startsWith('=') ? raw.slice(1) : raw;
  try {
    const obj = JSON.parse(body) as { symbol?: string };
    if (obj && typeof obj.symbol === 'string') return obj.symbol;
  } catch {
    /* not JSON — fall through */
  }
  return raw;
}

interface Row {
  symbol: string;
  alert_id: string;
  active: string;
  fired: string;
  type: string;
  webhook: string;
  message: string;
}

// Run a cookie-authenticated request to pricealerts from the page context. `bodyStr`, when
// present, is a pre-serialized JSON string sent verbatim as the (text/plain) request body —
// it is injected into the evaluated expression as a single JSON string literal, so no
// caller value can break out. Returns the parsed response (or a {s:'fetch_error'} envelope).
async function callPriceAlerts(
  page: Parameters<typeof ensureChart>[0],
  path: string,
  bodyStr: string | null,
): Promise<{ s?: string; r?: unknown; errmsg?: string; err?: { code?: string }; id?: string }> {
  const init =
    bodyStr === null
      ? `{ credentials: 'include' }`
      : `{ method: 'POST', credentials: 'include', body: ${JSON.stringify(bodyStr)} }`;
  const raw = await page.evaluate<string>(
    `fetch('${PRICEALERTS}${path}', ${init})
      .then((r) => r.text())
      .catch((e) => JSON.stringify({ s: 'fetch_error', errmsg: (e && e.message) || String(e) }))`,
  );
  try {
    return JSON.parse(raw) as { s?: string; r?: unknown; errmsg?: string; err?: { code?: string } };
  } catch {
    return { s: 'parse_error', errmsg: String(raw).slice(0, 200) };
  }
}

cli({
  site: 'tradingview',
  name: 'alert',
  description:
    'List / create / delete account price alerts (the unattended-watch control surface: server-side alert -> webhook -> downstream executor)',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'list', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    // list filters
    { name: 'fired', help: 'list: only alerts that have fired at least once (flag)' },
    { name: 'active', help: 'list: only currently-active alerts (flag)' },
    // create
    { name: 'symbol', help: 'create: ticker e.g. OKX:ETHUSD (default: active chart symbol)' },
    { name: 'price', help: 'create: price level the condition tests against (required)' },
    { name: 'condition', help: `create: ${CONDITIONS.join('|')} (default cross)`, choices: [...CONDITIONS] },
    { name: 'resolution', help: 'create: timeframe e.g. 15 / 1h / 1D (default: active chart timeframe)' },
    { name: 'message', help: 'create: alert message text (default: "<sym> <condition> <price>")' },
    { name: 'webhook', help: 'create: HTTPS URL TradingView POSTs to when the alert fires (the downstream-routing endpoint)' },
    { name: 'currency', help: 'create: quote currency-id for the symbol wrapper (default USD)' },
    { name: 'once', help: 'create: fire once then auto-deactivate (flag; default: stay armed and re-fire on each cross)' },
    { name: 'expire-days', help: 'create: days until the alert expires (default 30)' },
    // delete
    { name: 'id', help: 'delete: alert_id(s), comma-separated (get ids via: tradingview alert list)' },
  ],
  columns: ['symbol', 'alert_id', 'active', 'fired', 'type', 'webhook', 'message'],
  func: async (page, kwargs): Promise<Row[]> => {
    const action = String(kwargs.action ?? 'list');
    await ensureChart(page);

    // ---- delete -------------------------------------------------------------
    if (action === 'delete') {
      const idRaw = kwargs.id ? String(kwargs.id) : '';
      const ids = idRaw
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length === 0) {
        throw new ArgumentError(
          'alert delete requires --id with one or more numeric alert_ids',
          'Example: tradingview alert delete --id 4810081528   (get ids via: tradingview alert list)',
        );
      }
      const body = JSON.stringify({ payload: { alert_ids: ids } });
      const res = await callPriceAlerts(page, '/delete_alerts', body);
      if (res.s !== 'ok') {
        throw new CommandExecutionError(
          `delete_alerts failed: ${res.err?.code ?? res.s ?? 'unknown'}`,
          res.errmsg ?? 'Verify the alert_id(s) exist via: tradingview alert list',
        );
      }
      return [
        { symbol: '', alert_id: ids.join(','), active: '', fired: '', type: 'delete', webhook: '', message: `deleted ${ids.length}` },
      ];
    }

    // ---- create -------------------------------------------------------------
    if (action === 'create') {
      const price = Number(kwargs.price);
      if (!Number.isFinite(price)) {
        throw new ArgumentError(
          'alert create requires a finite --price (the level the condition tests against)',
          'Example: tradingview alert create --price 4000 --condition cross_up --webhook https://my.host/tv',
        );
      }
      const condition = String(kwargs.condition ?? 'cross');
      if (!(CONDITIONS as readonly string[]).includes(condition)) {
        throw new ArgumentError(`--condition must be one of: ${CONDITIONS.join('|')}`, `Got: ${condition}`);
      }

      // Default symbol/resolution from the active chart when not given explicitly.
      const live = JSON.parse(
        await page.evaluate<string>(
          `JSON.stringify((() => { const c = window.TradingViewApi.activeChart(); const e = (c.symbolExt && c.symbolExt()) || null; return { sym: (e && e.pro_name) || c.symbol(), res: c.resolution() }; })())`,
        ),
      ) as { sym: string; res: string };

      const symbol = kwargs.symbol ? normalizeSymbol(String(kwargs.symbol)) : live.sym;
      const resolution = kwargs.resolution ? normalizeInterval(String(kwargs.resolution)) : String(live.res);
      const currency = kwargs.currency ? String(kwargs.currency) : 'USD';
      const message = kwargs.message ? String(kwargs.message) : `${symbol} ${condition} ${price}`;
      const webhook = kwargs.webhook ? String(kwargs.webhook) : null;
      const autoDeactivate = !!kwargs.once && String(kwargs.once) !== 'false';
      const expireDays = Number(kwargs['expire-days'] ?? 30);
      const days = Number.isFinite(expireDays) && expireDays > 0 ? expireDays : 30;
      const expiration = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

      // The '=' + JSON wrapper is mandatory; a bare ticker is rejected. The server
      // re-normalizes and echoes back adjustment/session defaults.
      const symbolField = '=' + JSON.stringify({ 'currency-id': currency, session: 'regular', symbol });

      const body = JSON.stringify({
        payload: {
          conditions: [
            {
              type: condition,
              frequency: 'on_first_fire',
              series: [{ type: 'barset' }, { type: 'value', value: price }],
              resolution,
            },
          ],
          symbol: symbolField,
          resolution,
          message,
          sound_file: null,
          sound_duration: 0,
          popup: true,
          auto_deactivate: autoDeactivate,
          email: false,
          sms_over_email: false,
          mobile_push: true,
          web_hook: webhook,
          name: null,
          expiration,
          active: true,
          ignore_warnings: true,
        },
      });

      const res = await callPriceAlerts(page, '/create_alert', body);
      if (res.s !== 'ok') {
        throw new CommandExecutionError(
          `create_alert failed: ${res.err?.code ?? res.s ?? 'unknown'}`,
          res.errmsg ??
            'Check the symbol resolves on this account and the price/condition are valid. Condition must be one of: ' +
              CONDITIONS.join('|'),
        );
      }
      const created = (res.r ?? {}) as RawAlert;
      return [
        {
          symbol,
          alert_id: created.alert_id != null ? String(created.alert_id) : '',
          active: 'yes',
          fired: '',
          type: condition,
          webhook: webhook ?? '',
          message,
        },
      ];
    }

    // ---- list (default) -----------------------------------------------------
    const body = await callPriceAlerts(page, '/list_alerts', null);
    if (body.s !== 'ok' || !Array.isArray(body.r)) {
      return [
        { symbol: 'ERROR', alert_id: '', active: '', fired: '', type: body.s ?? 'error', webhook: '', message: body.errmsg ?? 'list_alerts did not return ok' },
      ];
    }

    const wantFired = !!kwargs.fired && String(kwargs.fired) !== 'false';
    const wantActive = !!kwargs.active && String(kwargs.active) !== 'false';

    return (body.r as RawAlert[])
      .filter((a) => (!wantActive || a.active === true) && (!wantFired || !!a.last_fire_time))
      .map((a) => ({
        symbol: cleanSymbol(a),
        alert_id: a.alert_id != null ? String(a.alert_id) : '',
        active: a.active ? 'yes' : 'no',
        fired: a.last_fire_time ?? '',
        type: a.type ?? '',
        webhook: a.web_hook ?? '',
        message: (a.message ?? '').replace(/\s+/g, ' ').slice(0, 120),
      }));
  },
});

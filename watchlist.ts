import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, normalizeSymbol } from './_helpers.js';

// Manage the custom watchlists on the logged-in account via TradingView's symbols_list REST
// backend. A watchlist is the agent's standing symbol universe for unattended scanning: the
// set of tickers it sweeps for setups, anomalies, and alert candidates while no one is home.
//
//   list   GET    https://www.tradingview.com/api/v1/symbols_list/custom/        -> [<watchlist>]
//   read   GET    https://www.tradingview.com/api/v1/symbols_list/custom/<id>/   -> <watchlist>
//   create POST   https://www.tradingview.com/api/v1/symbols_list/custom/        -> 201 <watchlist>
//   add    POST   https://www.tradingview.com/api/v1/symbols_list/custom/<id>/append/ -> 200 [symbols]
//   remove POST   https://www.tradingview.com/api/v1/symbols_list/custom/<id>/remove/ -> 200 [symbols]
//   delete DELETE https://www.tradingview.com/api/v1/symbols_list/custom/<id>/   -> 204 (empty)
//
// Unlike pricealerts, this backend is SAME-origin to www.tradingview.com, so there is no CORS
// constraint: Content-Type: application/json is fine and no preflight is rejected. Auth is the
// HttpOnly sessionid cookie (auto-sent with credentials:'include'); there is NO CSRF token —
// a same-origin write authorized by sessionid alone returns 201/200/204.
//
// Wire shapes confirmed by probe against the live endpoint (a disposable TEST_DELETE_ME list
// was created, appended to, had a symbol removed, then deleted and verified 404-gone):
//   <watchlist>  : { id, type:'custom', name, symbols:[<ticker|'###Section'>], active,
//                    shared, color, description, created, modified }
//   create body  : { name, symbols:[<ticker>, ...] }  -> 201 <watchlist>
//   add body     : ["EXCHANGE:SYM", ...]   (append/ echoes the merged symbols array)
//   remove body  : ["EXCHANGE:SYM", ...]   (remove/ echoes the trimmed symbols array)
//
// Probed constraints:
//   - symbols[] entries prefixed with '###' are section-divider headers, not tickers.
//   - the base id endpoint (/<id>/) only answers GET and DELETE; PUT/PATCH/POST -> 405.
//     There is NO exposed rename: to rename, delete + recreate (a known gap).
//   - /<id>/replace/ is reorder-only ("safe replace") and rejects NEW symbols with code
//     'add_new_symbols' — use append/ to add, not replace/.
//   - create stores a multi-element symbols[] element-wise (n=3 in -> n=3 stored, probed);
//     append/ likewise appends element-wise. No server-side array collapse.
//
// CLI gotcha (PowerShell): an UNQUOTED --symbols a,b,c is parsed by PowerShell's comma
// array operator into a 3-element argv array, which opencli space-joins into ONE token, so
// parseSymbols then sees one space-separated string and split(',') yields one element.
// ALWAYS quote the list: --symbols "OKX:ETHUSD,OKX:BTCUSD,NASDAQ:AAPL".

const ACTIONS = ['list', 'create', 'add', 'remove', 'delete'] as const;

const API = 'https://www.tradingview.com/api/v1/symbols_list/custom';

interface RawWatchlist {
  id?: number;
  name?: string;
  symbols?: string[];
  active?: boolean;
  shared?: boolean;
  color?: string | null;
  description?: string | null;
}

interface Row {
  watchlist_id: string;
  name: string;
  count: string;
  active: string;
  symbols: string;
}

// Run a cookie-authenticated, same-origin request to the symbols_list backend from the page
// context. `body`, when present, is a pre-serialized JSON string sent verbatim as the
// application/json request body — it is injected into the evaluated expression as a single
// JSON string literal, so no caller value can break out. Returns { status, text } so callers
// can branch on the (sometimes empty-bodied, e.g. 204) HTTP status.
async function callSymbolsList(
  page: Parameters<typeof ensureChart>[0],
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body: string | null,
): Promise<{ status: number; text: string }> {
  const initParts = [`method: ${JSON.stringify(method)}`, `credentials: 'include'`];
  if (body !== null) {
    initParts.push(`headers: { 'Content-Type': 'application/json' }`);
    initParts.push(`body: ${JSON.stringify(body)}`);
  }
  const init = `{ ${initParts.join(', ')} }`;
  const raw = await page.evaluate<string>(
    `fetch('${API}${path}', ${init})
      .then((res) => res.text().then((t) => JSON.stringify({ status: res.status, text: t })))
      .catch((e) => JSON.stringify({ status: 0, text: JSON.stringify({ fetch_error: (e && e.message) || String(e) }) }))`,
  );
  try {
    return JSON.parse(raw) as { status: number; text: string };
  } catch {
    return { status: -1, text: String(raw).slice(0, 200) };
  }
}

// Append symbols to a watchlist in one POST to append/, which echoes the merged symbols
// array element-wise. Returns that array (or {ok:false} on a non-2xx status).
async function appendSymbols(
  page: Parameters<typeof ensureChart>[0],
  id: string,
  symbols: string[],
): Promise<{ ok: boolean; status: number; text: string; symbols: string[] }> {
  if (symbols.length === 0) return { ok: true, status: 200, text: '[]', symbols: [] };
  const res = await callSymbolsList(page, `/${id}/append/`, 'POST', JSON.stringify(symbols));
  if (res.status !== 200 && res.status !== 201) return { ok: false, status: res.status, text: res.text, symbols: [] };
  let resulting: string[] = [];
  try {
    const parsed = JSON.parse(res.text);
    if (Array.isArray(parsed)) resulting = parsed as string[];
    else if (parsed && Array.isArray((parsed as RawWatchlist).symbols)) resulting = (parsed as RawWatchlist).symbols!;
  } catch {
    /* non-array body — leave empty */
  }
  return { ok: true, status: res.status, text: res.text, symbols: resulting };
}

// Parse a watchlist's symbols[] into a compact, divider-free preview for the symbols column.
function symbolPreview(symbols: string[] | undefined): { count: number; preview: string } {
  const tickers = (symbols ?? []).filter((s) => typeof s === 'string' && !s.startsWith('###'));
  return { count: tickers.length, preview: tickers.slice(0, 12).join(' ') + (tickers.length > 12 ? ' …' : '') };
}

// Comma-separated --symbols -> normalized, de-duplicated ticker list.
function parseSymbols(raw: unknown): string[] {
  const seen = new Set<string>();
  return String(raw ?? '')
    .split(',')
    .map((s) => normalizeSymbol(s.trim()))
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true));
}

cli({
  site: 'tradingview',
  name: 'watchlist',
  description:
    'List / create / add-to / remove-from / delete account custom watchlists (the standing symbol universe the agent sweeps for setups while unattended)',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'list', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    { name: 'id', help: 'read/add/remove/delete: watchlist id (get ids via: tradingview watchlist list)' },
    { name: 'name', help: 'create: watchlist name (required for create)' },
    { name: 'symbols', help: 'create/add/remove: comma-separated tickers, QUOTE the list e.g. "OKX:ETHUSD,NASDAQ:AAPL"' },
  ],
  columns: ['watchlist_id', 'name', 'count', 'active', 'symbols'],
  func: async (page, kwargs): Promise<Row[]> => {
    const action = String(kwargs.action ?? 'list');
    await ensureChart(page);

    // ---- delete -------------------------------------------------------------
    if (action === 'delete') {
      const id = kwargs.id ? String(kwargs.id).trim() : '';
      if (!/^\d+$/.test(id)) {
        throw new ArgumentError(
          'watchlist delete requires a numeric --id',
          'Example: tradingview watchlist delete --id 333757693   (get ids via: tradingview watchlist list)',
        );
      }
      const res = await callSymbolsList(page, `/${id}/`, 'DELETE', null);
      if (res.status !== 204 && res.status !== 200) {
        throw new CommandExecutionError(
          `delete watchlist ${id} failed: HTTP ${res.status}`,
          res.text.slice(0, 200) || 'Verify the id exists via: tradingview watchlist list',
        );
      }
      return [{ watchlist_id: id, name: '', count: '', active: '', symbols: 'deleted' }];
    }

    // ---- create -------------------------------------------------------------
    if (action === 'create') {
      const name = kwargs.name ? String(kwargs.name).trim() : '';
      if (!name) {
        throw new ArgumentError(
          'watchlist create requires --name',
          'Example: tradingview watchlist create --name "Crypto majors" --symbols "OKX:ETHUSD,OKX:BTCUSD"',
        );
      }
      const symbols = parseSymbols(kwargs.symbols);
      const res = await callSymbolsList(page, '/', 'POST', JSON.stringify({ name, symbols }));
      if (res.status !== 201 && res.status !== 200) {
        throw new CommandExecutionError(
          `create watchlist failed: HTTP ${res.status}`,
          res.text.slice(0, 200) || 'Check the name is valid.',
        );
      }
      const created = JSON.parse(res.text) as RawWatchlist;
      const newId = created.id != null ? String(created.id) : '';
      const { count, preview } = symbolPreview(created.symbols);
      return [
        {
          watchlist_id: newId,
          name: created.name ?? name,
          count: String(count),
          active: created.active ? 'yes' : 'no',
          symbols: preview,
        },
      ];
    }

    // ---- add / remove -------------------------------------------------------
    if (action === 'add' || action === 'remove') {
      const id = kwargs.id ? String(kwargs.id).trim() : '';
      if (!/^\d+$/.test(id)) {
        throw new ArgumentError(
          `watchlist ${action} requires a numeric --id`,
          `Example: tradingview watchlist ${action} --id 333757693 --symbols OKX:ETHUSD`,
        );
      }
      const symbols = parseSymbols(kwargs.symbols);
      if (symbols.length === 0) {
        throw new ArgumentError(
          `watchlist ${action} requires --symbols with one or more tickers`,
          `Example: tradingview watchlist ${action} --id ${id} --symbols "OKX:ETHUSD,NASDAQ:AAPL"`,
        );
      }
      // add POSTs to append/, remove POSTs to remove/; both echo the resulting symbols array.
      let resulting: string[] = [];
      if (action === 'add') {
        const add = await appendSymbols(page, id, symbols);
        if (!add.ok) {
          throw new CommandExecutionError(
            `watchlist add on ${id} failed: HTTP ${add.status}`,
            add.text.slice(0, 200) || 'Verify the id exists via: tradingview watchlist list',
          );
        }
        resulting = add.symbols;
      } else {
        const res = await callSymbolsList(page, `/${id}/remove/`, 'POST', JSON.stringify(symbols));
        if (res.status !== 200 && res.status !== 201) {
          throw new CommandExecutionError(
            `watchlist remove on ${id} failed: HTTP ${res.status}`,
            res.text.slice(0, 200) || 'Verify the id exists via: tradingview watchlist list',
          );
        }
        try {
          const parsed = JSON.parse(res.text);
          if (Array.isArray(parsed)) resulting = parsed as string[];
          else if (parsed && Array.isArray((parsed as RawWatchlist).symbols)) resulting = (parsed as RawWatchlist).symbols!;
        } catch {
          /* non-array body — leave resulting empty */
        }
      }
      const { count, preview } = symbolPreview(resulting);
      return [
        {
          watchlist_id: id,
          name: `${action} ${symbols.join(',')}`,
          count: String(count),
          active: '',
          symbols: preview,
        },
      ];
    }

    // ---- list (default) -----------------------------------------------------
    // One watchlist when --id is given, otherwise every custom watchlist on the account.
    const id = kwargs.id ? String(kwargs.id).trim() : '';
    if (id) {
      if (!/^\d+$/.test(id)) {
        throw new ArgumentError('watchlist list --id must be numeric', `Got: ${id}`);
      }
      const res = await callSymbolsList(page, `/${id}/`, 'GET', null);
      if (res.status !== 200) {
        return [{ watchlist_id: id, name: 'ERROR', count: '', active: '', symbols: `HTTP ${res.status}: ${res.text.slice(0, 120)}` }];
      }
      const wl = JSON.parse(res.text) as RawWatchlist;
      const { count, preview } = symbolPreview(wl.symbols);
      return [
        {
          watchlist_id: wl.id != null ? String(wl.id) : id,
          name: wl.name ?? '',
          count: String(count),
          active: wl.active ? 'yes' : 'no',
          symbols: preview,
        },
      ];
    }

    const res = await callSymbolsList(page, '/', 'GET', null);
    if (res.status !== 200) {
      return [{ watchlist_id: '', name: 'ERROR', count: '', active: '', symbols: `HTTP ${res.status}: ${res.text.slice(0, 120)}` }];
    }
    let lists: RawWatchlist[];
    try {
      const parsed = JSON.parse(res.text);
      lists = Array.isArray(parsed) ? (parsed as RawWatchlist[]) : [];
    } catch {
      return [{ watchlist_id: '', name: 'ERROR', count: '', active: '', symbols: 'list did not return JSON' }];
    }
    return lists.map((wl) => {
      const { count, preview } = symbolPreview(wl.symbols);
      return {
        watchlist_id: wl.id != null ? String(wl.id) : '',
        name: wl.name ?? '',
        count: String(count),
        active: wl.active ? 'yes' : 'no',
        symbols: preview,
      };
    });
  },
});

import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart } from './_helpers.js';

// Batch alert management: deploy / validate / delete alerts from a CSV file.
// Mirrors the REST API wire shapes in alert.ts (list/create/delete), so a single
// alert create/delete call is also valid CSV input. CSV is the canonical exchange
// format between tv-alert-batch.sh (BBX era) and this plugin (API era).
//
// CSV columns (header row required):
//   symbol,condition,price,message,webhook,expire_days,currency,once
//   OKX:ETHUSD,cross_up,3200,ETH breakout,https://hook.example/eth,7,,false
//   SSE:600519,greater,1500,Moutai above 1500,,30,CNY,true
//
// Operators (CSV -> TV API):
//   cross      -> cross       (price crosses the level)
//   cross_up   -> cross_up    (crosses from below)
//   cross_down -> cross_down  (crosses from above)
//   >          -> greater     (plain greater-than, no cross semantics)
//   <          -> less        (plain less-than)
//   >=         -> greater     (TV has no >=; approximate with greater)
//   <=         -> less        (TV has no <=; approximate with less)
//
// Note: TV alerts are scoped to one symbol + one price per alert. A multi-condition
// alert (e.g., "price > X AND RSI < Y") must be composed as Pine Script and loaded
// via `indicator add --pine` — this batch tool creates only price-level alerts.

const PRICEALERTS = 'https://pricealerts.tradingview.com';
const CONDITIONS = ['cross', 'cross_up', 'cross_down', 'greater', 'less'] as const;

// CSV row interface (matches file columns)
interface AlertRow {
  symbol: string;
  condition: string;
  price: string;
  message: string;
  webhook: string;
  expire_days: string;
  currency: string;
  once: string;
}

// Parse CSV text into array of AlertRow (header row stripped, blank lines skipped).
// Handles both LF and CRLF line endings. Value cells are trimmed.
function parseCsv(text: string): AlertRow[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  // Normalize header variations
  const normalizedHeader = header
    .replace(/['"]/g, '')
    .split(/[,\t]/)
    .map((h) => h.trim());
  const col = (row: string[], name: string): string => {
    const i = normalizedHeader.indexOf(name);
    return i >= 0 && i < row.length ? row[i].trim().replace(/^["']|["']$/g, '') : '';
  };
  return lines.slice(1).map((line) => {
    const cells = line.split(/[,\t](?=(?:(?:[^"']*["']){2})*[^"']*$)/);
    return {
      symbol: col(cells, 'symbol'),
      condition: col(cells, 'condition') || 'cross',
      price: col(cells, 'price'),
      message: col(cells, 'message'),
      webhook: col(cells, 'webhook'),
      expire_days: col(cells, 'expire_days') || '30',
      currency: col(cells, 'currency') || 'USD',
      once: col(cells, 'once') || 'false',
    };
  });
}

// Map human-readable CSV operator to the TV API type string.
function mapCondition(op: string): string {
  const s = op.trim().toLowerCase();
  if (s === 'cross_up') return 'cross_up';
  if (s === 'cross_down') return 'cross_down';
  if (s === 'greater' || s === '>' || s === '>=') return 'greater';
  if (s === 'less' || s === '<' || s === '<=') return 'less';
  return 'cross';
}

// Build the pricealerts REST request body for one alert row.
function buildCreateBody(row: AlertRow): string {
  const price = parseFloat(row.price);
  if (!Number.isFinite(price)) return '';
  const condition = mapCondition(row.condition);
  const currency = row.currency || 'USD';
  const message = row.message || `${row.symbol} ${condition} ${row.price}`;
  const webhook = row.webhook || null;
  const once = row.once === 'true' || row.once === '1';
  const expireDays = parseInt(row.expire_days, 10) || 30;
  const expiration = new Date(Date.now() + expireDays * 86_400_000).toISOString();
  const symbolField = '=' + JSON.stringify({ 'currency-id': currency, session: 'regular', symbol: row.symbol });
  return JSON.stringify({
    payload: {
      conditions: [{ type: condition, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: '' }],
      symbol: symbolField,
      resolution: '',
      message,
      sound_file: null,
      sound_duration: 0,
      popup: true,
      auto_deactivate: once,
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
}

// Read CSV from a file path or stdin.
async function readCsv(path: string): Promise<string> {
  const fs = await import('fs');
  if (path === '-') {
    // Read from stdin (node --eval or pipe)
    const { stdin } = await import('process');
    return new Promise<string>((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => { data += chunk; });
      stdin.on('end', () => resolve(data));
      stdin.on('error', reject);
    });
  }
  return fs.readFileSync(path, 'utf8');
}

interface ResultRow {
  action: string;
  symbol: string;
  alert_id: string;
  price: string;
  status: string;
}

cli({
  site: 'tradingview',
  name: 'alert-batch',
  description: 'Batch alert deploy / validate / delete from CSV (one alert per row)',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    {
      name: 'action',
      positional: true,
      default: 'deploy',
      help: 'deploy | validate | delete | dry-run',
      choices: ['deploy', 'validate', 'delete', 'dry-run'],
    },
    { name: 'csv', positional: true, help: 'CSV file path (use "-" for stdin)' },
    { name: 'force', help: 'deploy: delete existing matching alerts before creating (flag)' },
    { name: 'dry-run', help: 'deploy: simulate without creating alerts (alias: action=dry-run)' },
  ],
  columns: ['action', 'symbol', 'alert_id', 'price', 'status'],
  func: async (page, kwargs): Promise<ResultRow[]> => {
    const action = String(kwargs.action ?? 'deploy');
    const csvPath = String(kwargs.csv ?? '-');
    const isDryRun = action === 'dry-run' || !!kwargs['dry-run'];
    const isValidate = action === 'validate';

    let csvText: string;
    try {
      csvText = await readCsv(csvPath);
    } catch (e) {
      throw new ArgumentError(`Cannot read CSV file "${csvPath}": ${e instanceof Error ? e.message : String(e)}`);
    }

    const rows = parseCsv(csvText);
    if (rows.length === 0) {
      throw new ArgumentError('CSV has no data rows (need a header + at least one alert row)');
    }

    // ---- validate ------------------------------------------------------------
    if (isValidate) {
      const results: ResultRow[] = [];
      for (const row of rows) {
        const price = parseFloat(row.price);
        const ok = row.symbol && Number.isFinite(price) && (CONDITIONS as readonly string[]).includes(mapCondition(row.condition));
        results.push({
          action: ok ? 'VALID' : 'INVALID',
          symbol: row.symbol,
          alert_id: '',
          price: row.price,
          status: ok ? 'ok' : `bad symbol="${row.symbol}" or price="${row.price}"`,
        });
      }
      return results;
    }

    await ensureChart(page);

    // Fetch existing alerts for dedup when --force or dry-run
    const existingList = await page.evaluate<string>(
      `fetch('${PRICEALERTS}/list_alerts', { credentials:'include' }).then(r=>r.text()).catch(()=>'[]')`,
    );
    let existing: Array<{ alert_id?: number; symbol?: string; message?: string }> = [];
    try { existing = JSON.parse(existingList)?.r ?? []; } catch { /* ignore */ }

    const results: ResultRow[] = [];

    for (const row of rows) {
      const price = parseFloat(row.price);
      if (!row.symbol || !Number.isFinite(price)) {
        results.push({ action: 'SKIP', symbol: row.symbol, alert_id: '', price: row.price, status: 'missing symbol or price' });
        continue;
      }

      const condition = mapCondition(row.condition);
      if (isDryRun) {
        const existingMatch = existing.find((a) => {
          const raw = a.symbol ?? '';
          const body = raw.startsWith('=') ? raw.slice(1) : raw;
          try {
            const obj = JSON.parse(body);
            return obj?.symbol === row.symbol && a.message === (row.message || `${row.symbol} ${condition} ${row.price}`);
          } catch { return raw === row.symbol; }
        });
        results.push({
          action: existingMatch ? 'EXISTS' : 'CREATE',
          symbol: row.symbol,
          alert_id: existingMatch?.alert_id != null ? String(existingMatch.alert_id) : '',
          price: row.price,
          status: existingMatch ? `alert_id=${existingMatch.alert_id}` : `${condition} ${price}`,
        });
        continue;
      }

      // delete matching existing alerts if --force
      if (kwargs.force && action === 'deploy') {
        const matches = existing.filter((a) => {
          const raw = a.symbol ?? '';
          const body = raw.startsWith('=') ? raw.slice(1) : raw;
          try {
            const obj = JSON.parse(body);
            return obj?.symbol === row.symbol;
          } catch { return raw === row.symbol; }
        });
        for (const m of matches) {
          if (m.alert_id != null) {
            const delBody = JSON.stringify({ payload: { alert_ids: [Number(m.alert_id)] } });
            await page.evaluate(
              `fetch('${PRICEALERTS}/delete_alerts',{method:'POST',credentials:'include',body:${JSON.stringify(delBody)}}).then(r=>r.text())`,
            );
          }
        }
      }

      // create
      const body = buildCreateBody(row);
      if (!body) {
        results.push({ action: 'SKIP', symbol: row.symbol, alert_id: '', price: row.price, status: 'invalid price' });
        continue;
      }

      const resText = await page.evaluate<string>(
        `fetch('${PRICEALERTS}/create_alert',{method:'POST',credentials:'include',body:${JSON.stringify(body)}}).then(r=>r.text()).catch(e=>JSON.stringify({s:'fetch_error',errmsg:e&&e.message}))`,
      );
      let res: { s?: string; r?: { alert_id?: number }; errmsg?: string };
      try { res = JSON.parse(resText); } catch { res = { s: 'parse_error', errmsg: resText.slice(0, 200) }; }

      if (res.s === 'ok') {
        results.push({
          action: 'CREATED',
          symbol: row.symbol,
          alert_id: res.r?.alert_id != null ? String(res.r.alert_id) : '',
          price: row.price,
          status: 'ok',
        });
      } else {
        results.push({
          action: 'ERROR',
          symbol: row.symbol,
          alert_id: '',
          price: row.price,
          status: res.errmsg ?? res.s ?? 'unknown',
        });
      }
    }

    return results;
  },
});

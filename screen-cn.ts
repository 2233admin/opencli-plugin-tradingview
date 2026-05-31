import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

// A-share market movers via TradingView's scanner API.
// Mirrors the approach of earnings.ts (browser:false JSON endpoint) and
// tv-screen-cn.sh (BBX DOM era).
//
// TV's chart内 Screener panel does NOT support country='China' — the country
// dropdown has no China entry. The standalone stocks-china page is the correct path:
//   https://www.tradingview.com/markets/stocks-china/market-movers-<subtype>/
// These pages are public (no login) and return a full HTML table that can be parsed.
//
// Sub-pages (same scanner endpoint, different sort/filter):
//   large-cap        -> market_cap_basic desc, P/E > 0 filter
//   active           -> volume desc (this was renamed from "most-active" in 2026-05)
//   gainers          -> change_percent desc
//   losers           -> change_percent asc
//   best-performing  -> performance_weeks_52w desc
//   high-dividend     -> dividend_rate_indication_annual desc
//   all-stocks       -> no filter, market_cap_basic desc
//
// Scanner endpoint (same as earnings.ts):
//   scanner.tradingview.com/china/scan
//   requires Origin: https://www.tradingview.com header (same-origin trick)
//
// Returns rows: symbol, name, price, change_pct, volume, market_cap, pe

const SUBTYPES = ['large-cap', 'active', 'gainers', 'losers', 'best-performing', 'high-dividend', 'all-stocks'] as const;

// The A-share screener columns (TV uses different field names than the US screener)
const COLUMNS = [
  'name',           // ticker code (e.g. 601398)
  'description',    // company name (Chinese)
  'close',          // last price in CNY
  'change_percent',  // % change
  'volume',          // trading volume
  'market_cap_basic',// market cap in CNY
  'pe_ratio',        // P/E ratio
  'dividend_rate_indication_annual', // annual dividend yield %
];

const ENDPOINT = 'https://scanner.tradingview.com/china/scan';

// Build the scanner filter for a subtype.
function buildFilter(subtype: string): Array<unknown> {
  switch (subtype) {
    case 'large-cap':
      return [
        { left: 'market_cap_basic', operation: 'greater', right: 10_000_000_000 },
        { left: 'pe_ratio', operation: 'ne', right: 0 },
      ];
    case 'gainers':
    case 'losers':
    case 'best-performing':
      return [];
    case 'high-dividend':
      return [{ left: 'dividend_rate_indication_annual', operation: 'greater', right: 0 }];
    default:
      return [];
  }
}

// Build the sort key for a subtype.
function buildSort(subtype: string): { sortBy: string; sortOrder: string } {
  switch (subtype) {
    case 'active':       return { sortBy: 'volume', sortOrder: 'desc' };
    case 'gainers':      return { sortBy: 'change_percent', sortOrder: 'desc' };
    case 'losers':       return { sortBy: 'change_percent', sortOrder: 'asc' };
    case 'best-performing': return { sortBy: 'performance_week_52w', sortOrder: 'desc' };
    case 'high-dividend': return { sortBy: 'dividend_rate_indication_annual', sortOrder: 'desc' };
    default:              return { sortBy: 'market_cap_basic', sortOrder: 'desc' };
  }
}

cli({
  site: 'tradingview',
  name: 'screen-cn',
  description:
    'A-share market movers (China stocks) via TradingView scanner: large-cap/active/gainers/losers/best-performing/high-dividend/all-stocks',
  access: 'read',
  domain: 'scanner.tradingview.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: 'subtype',
      default: 'large-cap',
      help: `market-movers subtype: ${SUBTYPES.join('|')}`,
      choices: [...SUBTYPES],
    },
    { name: 'limit', type: 'int', default: 100, help: 'Max rows (sorted by subtype key)' },
  ],
  columns: ['symbol', 'name', 'price', 'change_pct', 'volume', 'market_cap', 'pe', 'dividend'],
  func: async (kwargs: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const subtype = String(kwargs.subtype ?? 'large-cap');
    const limit = Number(kwargs.limit ?? 100);

    const body = {
      filter: buildFilter(subtype),
      columns: COLUMNS,
      sort: buildSort(subtype),
      range: [0, limit],
    };

    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.tradingview.com',
        Referer: 'https://www.tradingview.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new CommandExecutionError(`TV scanner returned HTTP ${resp.status} ${resp.statusText}`);
    }

    const json = (await resp.json()) as { data?: Array<{ s: string; d: unknown[] }> };
    if (!Array.isArray(json.data)) {
      throw new CommandExecutionError('TV scanner returned unexpected payload shape');
    }

    // TV scanner returns data in the order of the `columns` array.
    // d[0]=name, d[1]=description, d[2]=close, d[3]=change_percent,
    // d[4]=volume, d[5]=market_cap_basic, d[6]=pe_ratio, d[7]=dividend_rate
    return json.data.map((row) => {
      const d = row.d as [string, string, number | null, number | null, number | null, number | null, number | null, number | null];
      const ticker = d[0] ?? '';
      // Auto-prefix: 6XXXXX -> SSE:, 0/3XXXXX -> SZSE:, else bare
      let symbol = ticker;
      if (/^6\d{5}$/.test(ticker)) symbol = `SSE:${ticker}`;
      else if (/^[03]\d{5}$/.test(ticker)) symbol = `SZSE:${ticker}`;
      return {
        symbol,
        name: d[1] ?? '',
        price: d[2] != null ? String(d[2]) : '',
        change_pct: d[3] != null ? String(d[3]) : '',
        volume: d[4] != null ? String(d[4]) : '',
        market_cap: d[5] != null ? String(d[5]) : '',
        pe: d[6] != null ? String(d[6]) : '',
        dividend: d[7] != null ? String(d[7]) : '',
      };
    });
  },
});

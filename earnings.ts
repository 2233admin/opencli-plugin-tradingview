import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';

// TradingView's earnings-calendar widget is iframe-isolated like the econ
// calendar, so DOM scraping the /earnings-calendar/ page yields nothing.
// Instead hit the same scanner API the screeners use:
// scanner.tradingview.com/<region>/scan accepts a JSON POST and only needs an
// Origin header to clear the 403 gate. browser:false, no login.
//
// Region is PATH-based (america / china / hongkong / japan / uk ...), NOT a
// query param, so one call = one region. Mirrors the econ-calendar adapter's
// JSON-endpoint approach; same browser:false discipline.
//
// Column semantics (verified 2026-05-29):
//   earnings_release_next_date          -> next scheduled earnings (Unix seconds; the time component encodes BMO/AMC)
//   earnings_per_share_forecast_next_fq -> consensus EPS estimate for that release (null when no analyst coverage)
//   earnings_per_share_fq               -> last reported actual EPS (context, prior quarter)
//   market_cap_basic                    -> market cap (sort key)
const REGIONS = ['america', 'china', 'hongkong', 'japan', 'uk', 'germany', 'india', 'korea'] as const;
const ENDPOINT = (region: string) => `https://scanner.tradingview.com/${region}/scan`;

cli({
  site: 'tradingview',
  name: 'earnings',
  description: 'Upcoming earnings calendar (next report date, consensus EPS estimate, last actual EPS) for a region + date window',
  access: 'read',
  domain: 'scanner.tradingview.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'region', default: 'america', help: `scanner region (${REGIONS.join('|')})`, choices: [...REGIONS] },
    { name: 'days', type: 'int', default: 7, help: 'Days forward from today (window = [today, today+days])' },
    { name: 'limit', type: 'int', default: 100, help: 'Max rows (sorted by market cap desc)' },
  ],
  columns: ['symbol', 'name', 'date', 'eps_estimate', 'eps_last', 'market_cap'],
  func: async (kwargs: Record<string, unknown>) => {
    const region = String(kwargs.region ?? 'america');
    const days = Number(kwargs.days ?? 7);
    const limit = Number(kwargs.limit ?? 100);

    const now = Math.floor(Date.now() / 1000);
    const to = now + days * 24 * 60 * 60;

    const body = {
      filter: [{ left: 'earnings_release_next_date', operation: 'in_range', right: [now, to] }],
      columns: [
        'name',
        'description',
        'earnings_release_next_date',
        'earnings_per_share_forecast_next_fq',
        'earnings_per_share_fq',
        'market_cap_basic',
      ],
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      range: [0, limit],
    };

    const resp = await fetch(ENDPOINT(region), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Origin: 'https://www.tradingview.com',
        Referer: 'https://www.tradingview.com/',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new CommandExecutionError(`TradingView scanner returned HTTP ${resp.status} ${resp.statusText}`);
    }
    const json = (await resp.json()) as { data?: Array<{ s: string; d: unknown[] }> };
    if (!Array.isArray(json.data)) {
      throw new CommandExecutionError('TradingView scanner returned an unexpected payload shape');
    }

    return json.data.map((row) => {
      // d order matches the requested `columns`; `description` (full company
      // name) is more useful than `name` (which is just the ticker code).
      const [, description, nextDate, epsEst, epsLast, mcap] = row.d as [
        string,
        string,
        number | null,
        number | null,
        number | null,
        number | null,
      ];
      return {
        symbol: row.s,
        name: description ?? '',
        date: nextDate ? new Date(nextDate * 1000).toISOString() : '',
        eps_estimate: epsEst ?? null,
        eps_last: epsLast ?? null,
        market_cap: mcap ?? null,
      };
    });
  },
});

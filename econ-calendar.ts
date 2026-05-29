import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';

// TradingView's economic-calendar widget is iframe-isolated, so DOM scraping
// the /economic-calendar/ page yields nothing. Instead hit the JSON endpoint
// the widget itself calls — it only requires an Origin header to clear the
// 403 gate. browser:false, no login needed.
const ENDPOINT = 'https://economic-calendar.tradingview.com/events';

cli({
  site: 'tradingview',
  name: 'econ-calendar',
  description: 'Macro economic calendar events (releases, forecasts, actuals) for a date window',
  access: 'read',
  domain: 'economic-calendar.tradingview.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'countries', default: 'US,CN,EU,JP', help: 'Comma-separated country codes (US,CN,EU,JP,GB,DE...)' },
    { name: 'days', type: 'int', default: 7, help: 'Days forward from today (window = [today, today+days])' },
    { name: 'min-importance', type: 'int', default: -1, help: 'Filter by importance (-1=all, 0=low, 1=medium, 2=high)' },
  ],
  columns: ['date', 'country', 'title', 'importance', 'actual', 'forecast', 'previous', 'unit', 'source'],
  func: async (kwargs: Record<string, unknown>) => {
    const countries = String(kwargs.countries ?? 'US,CN,EU,JP');
    const days = Number(kwargs.days ?? 7);
    const minImp = Number(kwargs['min-importance'] ?? -1);

    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
    const url = `${ENDPOINT}?from=${from.toISOString()}&to=${to.toISOString()}&countries=${encodeURIComponent(countries)}`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Origin: 'https://www.tradingview.com',
        Referer: 'https://www.tradingview.com/',
      },
    });
    if (!resp.ok) {
      throw new CommandExecutionError(`TradingView calendar returned HTTP ${resp.status} ${resp.statusText}`);
    }
    const json = (await resp.json()) as { status?: string; result?: unknown[] };
    if (json?.status !== 'ok' || !Array.isArray(json.result)) {
      throw new CommandExecutionError('TradingView calendar returned an unexpected payload shape');
    }

    return json.result
      .map((e) => e as Record<string, unknown>)
      .filter((e) => minImp < 0 || Number(e.importance ?? -99) >= minImp)
      .map((e) => ({
        date: String(e.date ?? ''),
        country: String(e.country ?? ''),
        title: String(e.title ?? ''),
        importance: Number(e.importance ?? 0),
        actual: e.actual ?? null,
        forecast: e.forecast ?? null,
        previous: e.previous ?? null,
        unit: String(e.unit ?? ''),
        source: String(e.source ?? ''),
      }));
  },
});

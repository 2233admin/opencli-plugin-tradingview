import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, jsLit } from './_helpers.js';

// Search TradingView's PUBLIC Pine script library by NAME to discover the
// scriptIdPart that `indicator add --pine` needs. A human types a name into the
// chart's indicator-search dialog and clicks a result; this is that search,
// headless. Hits the same endpoint the dialog uses:
//   GET https://www.tradingview.com/pubscripts-suggest-json/?search=<q>
//     -> { results: [{ scriptName, title, shortTitle, scriptIdPart:"PUB;<hash>",
//          version, access, agreeCount(=likes), author:{username}, extra:{kind} }] }
// Probed live. access: 1=open-source (loadable by id), 2=protected, 3=invite-only.
// Feed scriptIdPart + version straight into the loader:
//   tradingview indicator add --pine "PUB;<hash>" --pine-version <version>

const ACCESS: Record<number, string> = { 1: 'open', 2: 'protected', 3: 'invite' };

cli({
  site: 'tradingview',
  name: 'pine',
  description: 'Search the public Pine script library by name to discover the scriptIdPart for `indicator add --pine` (headless equivalent of the chart indicator-search dialog)',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'query', positional: true, help: 'script name to search, e.g. "supertrend"' },
    { name: 'limit', help: 'max rows to return (default 20, max 100)' },
    { name: 'kind', help: 'filter by kind: study|strategy' },
    { name: 'open', type: 'boolean', default: false, help: 'only open-source results (access=open, loadable by id)' },
  ],
  columns: ['pine_id', 'name', 'author', 'version', 'likes', 'kind', 'access'],
  func: async (page, kwargs) => {
    const query = String(kwargs.query ?? '').trim();
    if (!query) throw new ArgumentError('pine search requires a query', 'Example: tradingview pine supertrend');
    await ensureChart(page);

    let limit = kwargs.limit != null ? Number(kwargs.limit) : 20;
    if (!Number.isFinite(limit) || limit < 1) limit = 20;
    limit = Math.min(Math.floor(limit), 100);
    const kind = kwargs.kind ? String(kwargs.kind).trim().toLowerCase() : '';
    const openOnly = kwargs.open === true;

    const url = `https://www.tradingview.com/pubscripts-suggest-json/?search=${encodeURIComponent(query)}`;
    const raw = await page.evaluate<string>(`fetch(${jsLit(url)}, { credentials: 'include' })
      .then((res) => res.text().then((t) => JSON.stringify({ status: res.status, text: t })))
      .catch((e) => JSON.stringify({ status: 0, text: JSON.stringify({ fetch_error: (e && e.message) || String(e) }) }))`);

    let envelope: { status: number; text: string };
    try {
      envelope = JSON.parse(raw);
    } catch {
      envelope = { status: -1, text: String(raw).slice(0, 200) };
    }
    if (envelope.status !== 200) {
      throw new ArgumentError(`pine search failed: HTTP ${envelope.status}`, envelope.text.slice(0, 200) || 'Confirm you are signed in to TradingView.');
    }

    let data: any;
    try {
      data = JSON.parse(envelope.text);
    } catch {
      throw new ArgumentError('pine search: response was not JSON', envelope.text.slice(0, 200));
    }
    let results: any[] = Array.isArray(data?.results) ? data.results : [];
    if (kind) results = results.filter((r) => String(r?.extra?.kind ?? '').toLowerCase() === kind);
    if (openOnly) results = results.filter((r) => Number(r?.access) === 1);
    if (results.length === 0) {
      return [{ pine_id: '', name: '(no matches)', author: '', version: '', likes: '', kind: '', access: '' }];
    }
    return results.slice(0, limit).map((r) => ({
      pine_id: String(r.scriptIdPart ?? ''),
      name: String(r.scriptName ?? r.title ?? ''),
      author: String(r.author?.username ?? ''),
      version: String(r.version ?? ''),
      likes: String(r.agreeCount ?? ''),
      kind: String(r.extra?.kind ?? ''),
      access: ACCESS[Number(r.access)] ?? String(r.access ?? ''),
    }));
  },
});

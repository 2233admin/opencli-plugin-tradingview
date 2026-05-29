import { cli, Strategy } from '@jackwener/opencli/registry';
import { TRADINGVIEW_DOMAIN, ensureChart } from './_helpers.js';

// Screenshot the bound chart tab. Reuses openCLI's own page.screenshot() (we do NOT
// re-implement capture) — the only value-add over a bare browser screenshot is that we
// assert the chart API is live and tag the output row with the current symbol, so a
// batch caller knows which symbol each file belongs to.
//
// Default filename: tv-<symbol>-<unix>.<fmt> in the CWD. Pass --path to override.

cli({
  site: 'tradingview',
  name: 'capture',
  description: 'Screenshot the bound chart tab (tagged with the current symbol)',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'path', help: 'output file path (default: tv-<symbol>-<unix>.<fmt> in CWD)' },
    { name: 'img-format', default: 'png', help: 'png|jpeg', choices: ['png', 'jpeg'] },
    { name: 'full-page', help: 'capture the full page instead of the viewport (flag)' },
  ],
  columns: ['symbol', 'path'],
  func: async (page, kwargs) => {
    await ensureChart(page);
    const symbol = await page.evaluate<string>('window.TradingViewApi.activeChart().symbol()');

    const format = (String(kwargs['img-format'] ?? 'png') === 'jpeg' ? 'jpeg' : 'png') as 'png' | 'jpeg';
    const fullPageRaw = kwargs['full-page'];
    const fullPage = !!fullPageRaw && String(fullPageRaw) !== 'false';

    const safeSym = symbol.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const defaultPath = `tv-${safeSym || 'chart'}-${Math.floor(Date.now() / 1000)}.${format}`;
    const path = kwargs.path ? String(kwargs.path) : defaultPath;

    // page.screenshot() always returns the base64 image; when a path is given it ALSO
    // writes the file. We pass a path, so report that path (never the base64 blob).
    await page.screenshot({ path, format, fullPage });
    return [{ symbol, path }];
  },
});

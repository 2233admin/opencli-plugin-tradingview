import { cli, Strategy } from '@jackwener/opencli/registry';
import { TRADINGVIEW_DOMAIN, normalizeSymbol } from './_helpers.js';

// TV technicals renders three computed-signal gauges — Oscillators, Moving
// Averages, and the combined Summary. Each is a speedometer whose center text
// is the verdict (Strong sell / Sell / Neutral / Buy / Strong buy) and whose
// footer is a "Sell N  Neutral N  Buy N" counter. The wrapping class hashes
// rotate every deploy, so we key off the STABLE structure: locate the block
// whose text matches the counter pattern, walk up to the container that also
// carries the section title, then parse name + verdict + counts. Same
// robustness principle as the news / financials adapters.
//
// The verdict is NOT a reliable text node (the gauge renders all five dial
// labels and hides four via CSS, so the first one is always "Neutral"). The
// stable signal is the gauge CONTAINER's semantic class modifier —
// `container-sell-<hash>` / `container-buy-<hash>` / `container-strong-buy-<hash>`
// etc. The hash rotates each deploy but the `container-{direction}-` prefix is
// stable, so we read the verdict off the class, not the text.

cli({
  site: 'tradingview',
  name: 'technicals',
  description: 'Extract TV computed technical signals (Oscillators / Moving Averages / Summary verdict + buy/neutral/sell counts)',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [{ name: 'symbol', positional: true, required: true, help: 'e.g. 600519, AAPL, NASDAQ:AAPL' }],
  columns: ['section', 'verdict', 'sell', 'neutral', 'buy'],
  func: async (page, kwargs) => {
    const sym = normalizeSymbol(String(kwargs.symbol));
    const urlSym = sym.replace(/:/g, '-');
    const url = `https://www.tradingview.com/symbols/${urlSym}/technicals/`;

    if (page.newTab) {
      await page.newTab(url);
    } else {
      await page.goto(url);
    }
    // Gauges hydrate client-side; the speedometers settle after a few seconds.
    await page.wait({ time: 6 });

    const rows = await page.evaluate<
      Array<{ section: string; verdict: string; sell: number; neutral: number; buy: number }>
    >(`(() => {
      const clean = (s) => (s || '').replace(/[\\u202a\\u202c\\u2068\\u2069]/g, '').trim();
      // Read the verdict off the gauge container's semantic class modifier.
      // Order matters: strong-* alternatives must precede their plain forms.
      const VERDICT_MAP = { 'strong-sell': 'Strong sell', 'strong-buy': 'Strong buy', sell: 'Sell', buy: 'Buy', neutral: 'Neutral' };
      const verdictOf = (node) => {
        const re = /container-(strong-sell|strong-buy|sell|buy|neutral)-/;
        for (const e of node.querySelectorAll('[class]')) {
          const m = (e.getAttribute('class') || '').match(re);
          if (m) return VERDICT_MAP[m[1]];
        }
        return '';
      };
      const counterRe = /Sell\\s*\\n?\\s*\\d+[\\s\\S]*Neutral\\s*\\n?\\s*\\d+[\\s\\S]*Buy\\s*\\n?\\s*\\d+/i;
      const out = [];
      const seenSections = new Set();
      const seenNodes = new Set();
      document.querySelectorAll('div, section').forEach(el => {
        const txt = clean(el.innerText || '');
        if (!counterRe.test(txt)) return;
        // Walk up to the container that also carries the section title.
        let node = el;
        for (let i = 0; i < 6 && node; i++) {
          if (/Oscillators|Moving Averages|Summary/i.test(clean(node.innerText || ''))) break;
          node = node.parentElement;
        }
        if (!node || seenNodes.has(node)) return;
        seenNodes.add(node);

        const lines = clean(node.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) return;
        const section = lines[0];
        if (!/^(Oscillators|Moving Averages|Summary)$/.test(section)) return;
        if (seenSections.has(section)) return;

        const verdict = verdictOf(node);

        // Counts: trailing label->number pairs (Sell N / Neutral N / Buy N).
        const counts = { Sell: null, Neutral: null, Buy: null };
        for (let i = 0; i < lines.length - 1; i++) {
          const label = lines[i];
          const next = lines[i + 1];
          if ((label === 'Sell' || label === 'Neutral' || label === 'Buy') && /^\\d+$/.test(next)) {
            counts[label] = Number(next);
          }
        }
        if (counts.Sell === null && counts.Neutral === null && counts.Buy === null) return;

        seenSections.add(section);
        out.push({
          section,
          verdict,
          sell: counts.Sell ?? 0,
          neutral: counts.Neutral ?? 0,
          buy: counts.Buy ?? 0,
        });
      });
      // Stable order: Summary first, then Oscillators, then Moving Averages.
      const order = { Summary: 0, Oscillators: 1, 'Moving Averages': 2 };
      out.sort((a, b) => (order[a.section] ?? 9) - (order[b.section] ?? 9));
      return out;
    })()`);

    return rows;
  },
});

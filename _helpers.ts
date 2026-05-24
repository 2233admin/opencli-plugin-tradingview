import { CommandExecutionError } from '@jackwener/opencli/errors';
import type { IPage } from '@jackwener/opencli/registry';

export const TRADINGVIEW_DOMAIN = 'www.tradingview.com';
export const DEFAULT_LAYOUT = process.env.TV_LAYOUT ?? 'UkpUJ5dZ';

// A-share auto-prefixing: 6XXXXX -> SSE:, 0XXXXX/3XXXXX -> SZSE:, anything with ':' kept verbatim.
export function normalizeSymbol(raw: string): string {
  const s = raw.trim();
  if (s.includes(':')) return s;
  if (/^6\d{5}$/.test(s)) return `SSE:${s}`;
  if (/^[03]\d{5}$/.test(s)) return `SZSE:${s}`;
  return s;
}

// Chrome throttles history fetch on hidden tabs — empty K-lines guaranteed even though title shows live quote.
export async function assertVisible(page: IPage): Promise<void> {
  const vis = await page.evaluate<string>('document.visibilityState');
  if (vis === 'hidden') {
    throw new CommandExecutionError(
      'TradingView chart: document.visibilityState=hidden — chart history fetch will be throttled.',
      'Bring the browser window/tab to foreground, or pass --no-vis-check to bypass.',
    );
  }
}

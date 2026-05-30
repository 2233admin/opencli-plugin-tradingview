import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart, jsLit } from './_helpers.js';

// Drive the chart's Bar Replay engine via the Charting-Library widget API:
//   window.TradingViewApi.replayApi() -> Promise<replayController>
//
// Replay = step the chart backward to a historical bar then walk it forward, so an
// unattended agent can re-run price action bar-by-bar (doStep) or auto-play it. The
// controller's buy/sell/position/closePosition methods are SIMULATED replay trades —
// deliberately NOT exposed here (this adapter never places orders, real or simulated).
//
// Ground-truth probed live against the running TV build:
//   - replayApi() returns a PROMISE; await it before use.
//   - read-state methods return WatchedValue objects -> call .value() to read.
//   - dates are Unix SECONDS (currentDate/getReplaySelectedDate/getReplayDepth).
//   - selectDate(sec) | selectRandomDate() | selectFirstAvailableDate() enter replay.
//   - doStep() advances the playback head one bar; getReplaySelectedDate is the anchor.
//   - stopReplay() (no-arg) exits replay and restores the full chart (leaveReplay needs
//     an arg and was a no-op no-arg in probing; stopReplay is the canonical exit).
//   - changeAutoplayDelay(ms): 100=10x .. 1000=1x(default) .. 10000=0.1x.

const ACTIONS = ['status', 'start', 'step', 'autoplay', 'speed', 'realtime', 'stop'] as const;

// Evaluate `body` with `rep` (awaited replay controller) and `wv` (WatchedValue
// unwrapper) in scope; `body` must `return` a JSON-serialisable value. Timeout-guarded
// so a hung replay call can't wedge the CLI. Resolves {ok,r} | {ok:false,error}.
async function runReplay(page: any, body: string, timeoutMs = 20000): Promise<any> {
  const raw = await page.evaluate<string>(`new Promise((resolve) => {
    const wv = (x) => { try { return (x && typeof x.value === 'function') ? x.value() : x; } catch (e) { return null; } };
    (async () => {
      try {
        const rep = await window.TradingViewApi.replayApi();
        const r = await (async () => { ${body} })();
        resolve(JSON.stringify({ ok: true, r }));
      } catch (e) { resolve(JSON.stringify({ ok: false, error: (e && e.message) || String(e) })); }
    })();
    setTimeout(() => resolve(JSON.stringify({ ok: false, error: 'timeout' })), ${timeoutMs});
  })`);
  return JSON.parse(raw);
}

// Unix seconds -> ISO; blank for null/0 so output rows stay clean.
const fmt = (sec: any): string =>
  typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : '';
const yn = (b: any): string => (b ? 'yes' : 'no');

cli({
  site: 'tradingview',
  name: 'replay',
  description: 'Drive Bar Replay on the bound chart (start/step/autoplay/speed/realtime/stop) so an unattended agent can re-run historical price action',
  access: 'write',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'status', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    { name: 'date', help: 'start: Unix seconds to begin replay at (within loaded history)' },
    { name: 'random', type: 'boolean', default: false, help: 'start: pick a random valid bar' },
    { name: 'first', type: 'boolean', default: false, help: 'start: jump to the first available bar' },
    { name: 'count', help: 'step: bars to advance (default 1, max 500)' },
    { name: 'delay', help: 'speed: autoplay delay ms (100=10x .. 1000=1x .. 10000=0.1x)' },
  ],
  columns: ['action', 'started', 'position', 'detail'],
  func: async (page, kwargs) => {
    const action = String(kwargs.action ?? 'status');
    await ensureChart(page);

    if (action === 'status') {
      const res = await runReplay(
        page,
        `return {
          available: wv(rep.isReplayAvailable()), started: wv(rep.isReplayStarted()),
          ready: wv(rep.isReadyToPlay()), autoplay: wv(rep.isAutoplayStarted()),
          earliest: wv(rep.getReplayDepth()), current: wv(rep.currentDate()),
          selected: wv(rep.getReplaySelectedDate()), delay: rep.autoplayDelay(),
        };`,
      );
      if (!res.ok) throw new ArgumentError(`replay status failed: ${res.error}`, 'Confirm the chart is loaded.');
      const r = res.r;
      const detail = `available=${yn(r.available)} ready=${yn(r.ready)} autoplay=${yn(r.autoplay)} earliest=${fmt(r.earliest)} delay=${r.delay}ms`;
      return [{ action: 'status', started: yn(r.started), position: fmt(r.current), detail }];
    }

    if (action === 'start') {
      const wantRandom = kwargs.random === true;
      const wantFirst = kwargs.first === true;
      const hasDate = kwargs.date != null && String(kwargs.date).trim() !== '';
      const picks = [hasDate, wantRandom, wantFirst].filter(Boolean).length;
      if (picks !== 1) {
        throw new ArgumentError(
          'replay start requires exactly one of --date <unixsec> | --random | --first',
          'Example: tradingview replay start --date 1768319837   (or --random / --first)',
        );
      }
      let selectCall: string;
      if (hasDate) {
        const date = Number(kwargs.date);
        if (!Number.isFinite(date) || date <= 0) {
          throw new ArgumentError('replay start --date must be positive Unix seconds', 'Example: --date 1768319837');
        }
        selectCall = `await Promise.resolve(rep.selectDate(${jsLit(date)}));`;
      } else if (wantRandom) {
        selectCall = `await Promise.resolve(rep.selectRandomDate());`;
      } else {
        selectCall = `await Promise.resolve(rep.selectFirstAvailableDate());`;
      }
      const res = await runReplay(
        page,
        `${selectCall}
         await new Promise((r) => setTimeout(r, 2500));
         return { started: wv(rep.isReplayStarted()), current: wv(rep.currentDate()), selected: wv(rep.getReplaySelectedDate()) };`,
      );
      if (!res.ok) throw new ArgumentError(`replay start failed: ${res.error}`, 'Date must fall within the loaded history; try --random or widen the chart range.');
      const r = res.r;
      if (!r.started) throw new ArgumentError('replay did not start', 'The selected date may be outside available history. Try --random or --first.');
      return [{ action: 'start', started: yn(r.started), position: fmt(r.current), detail: `replay anchored at ${fmt(r.selected)}` }];
    }

    if (action === 'step') {
      let count = kwargs.count != null ? Number(kwargs.count) : 1;
      if (!Number.isFinite(count) || count < 1) count = 1;
      count = Math.min(Math.floor(count), 500);
      const res = await runReplay(
        page,
        `if (!wv(rep.isReplayStarted())) throw new Error('replay not started');
         for (let i = 0; i < ${count}; i++) { await Promise.resolve(rep.doStep()); await new Promise((r) => setTimeout(r, 150)); }
         return { current: wv(rep.currentDate()), started: wv(rep.isReplayStarted()) };`,
        Math.max(20000, count * 400 + 5000),
      );
      if (!res.ok) {
        if (String(res.error).includes('not started')) {
          throw new ArgumentError('replay step requires replay to be started', 'Run first: tradingview replay start --random');
        }
        throw new ArgumentError(`replay step failed: ${res.error}`, 'Try a smaller --count or re-start replay.');
      }
      return [{ action: 'step', started: yn(res.r.started), position: fmt(res.r.current), detail: `advanced ${count} bar(s)` }];
    }

    if (action === 'autoplay') {
      const res = await runReplay(
        page,
        `if (!wv(rep.isReplayStarted())) throw new Error('replay not started');
         await Promise.resolve(rep.toggleAutoplay());
         return { autoplay: wv(rep.isAutoplayStarted()), started: wv(rep.isReplayStarted()), current: wv(rep.currentDate()) };`,
      );
      if (!res.ok) {
        if (String(res.error).includes('not started')) {
          throw new ArgumentError('replay autoplay requires replay to be started', 'Run first: tradingview replay start --random');
        }
        throw new ArgumentError(`replay autoplay failed: ${res.error}`, 'Re-start replay and retry.');
      }
      return [{ action: 'autoplay', started: yn(res.r.started), position: fmt(res.r.current), detail: `autoplay ${res.r.autoplay ? 'on' : 'off'}` }];
    }

    if (action === 'speed') {
      const delay = Number(kwargs.delay);
      if (!Number.isFinite(delay) || delay <= 0) {
        throw new ArgumentError('replay speed requires --delay in ms', 'Presets: 100=10x 200=5x 1000=1x 3000=0.3x 10000=0.1x. Example: --delay 200');
      }
      const res = await runReplay(
        page,
        `await Promise.resolve(rep.changeAutoplayDelay(${jsLit(delay)}));
         return { delay: rep.autoplayDelay(), started: wv(rep.isReplayStarted()), current: wv(rep.currentDate()) };`,
      );
      if (!res.ok) throw new ArgumentError(`replay speed failed: ${res.error}`, 'Use a positive ms value.');
      return [{ action: 'speed', started: yn(res.r.started), position: fmt(res.r.current), detail: `delay=${res.r.delay}ms` }];
    }

    if (action === 'realtime') {
      const res = await runReplay(
        page,
        `await Promise.resolve(rep.goToRealtime());
         return { started: wv(rep.isReplayStarted()), current: wv(rep.currentDate()) };`,
      );
      if (!res.ok) throw new ArgumentError(`replay realtime failed: ${res.error}`, 'Replay may not be started.');
      return [{ action: 'realtime', started: yn(res.r.started), position: fmt(res.r.current), detail: 'jumped to realtime edge' }];
    }

    // stop
    const res = await runReplay(
      page,
      `await Promise.resolve(rep.stopReplay());
       await new Promise((r) => setTimeout(r, 800));
       return { started: wv(rep.isReplayStarted()) };`,
    );
    if (!res.ok) throw new ArgumentError(`replay stop failed: ${res.error}`, 'The chart may already be out of replay.');
    return [{ action: 'stop', started: yn(res.r.started), position: '', detail: res.r.started ? 'still in replay' : 'replay stopped, chart restored' }];
  },
});

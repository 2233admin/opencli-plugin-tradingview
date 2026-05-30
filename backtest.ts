import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { TRADINGVIEW_DOMAIN, ensureChart } from './_helpers.js';

// Read the Strategy Tester backtest report for the strategy on the bound chart, so an
// unattended agent can validate a Pine strategy (net profit, win rate, drawdown, trades)
// without watching the screen. This command is READ-ONLY: it never loads strategies or
// places orders. Load a strategy first with:
//     tradingview indicator add --pine "PUB;<hash>" --pine-version <v>
// (a strategy is a Pine script whose kind=strategy; find one via `tradingview pine
// "<query>" --kind strategy`). The strategy stays on the persistent chart tab across
// separate CLI processes, so `backtest report` in a later invocation reads it. Remove it
// after with `tradingview indicator remove --id <id>`.
//
// Ground-truth probed live against the running TV build:
//   - window.TradingViewApi.backtestingStrategyApi() -> the Strategy Tester controller
//     (a 0-arg method on the API; returns a singleton, READ-ONLY to call).
//   - controller.activeStrategyReportData / activeStrategyStatus / activeStrategy /
//     isStrategyEmpty / allStrategies are WatchedValue PROPERTIES (not methods) ->
//     read with .value(). They are null/empty until a strategy study is on the chart
//     AND its backtest has computed (status.type settles to 2).
//   - activeStrategyReportData.value() = {
//       currency, settings:{dateRange:{backtest:{from,to(ms)},trade:{from,to(ms)}}},
//       buyHold:[..], buyHoldPercent:[..],            // per-bar equity arrays (large)
//       performance:{
//         all:{netProfit, netProfitPercent, grossProfit, grossLoss, profitFactor,
//              percentProfitable, totalTrades, numberOfWiningTrades, numberOfLosingTrades,
//              avgTrade, avgWinTrade, avgLosTrade, ratioAvgWinAvgLoss, largestWinTrade,
//              largestLosTrade, commissionPaid, maxContractsHeld, returnOnAccount,
//              annualizedReturn, expectedPayoff, ...},
//         long:{...}, short:{...},                    // same shape, side-split
//         initialCapital, sharpeRatio, sortinoRatio,
//         maxStrategyDrawDown, maxStrategyDrawDownPercent,
//         buyHoldReturn, buyHoldReturnPercent, ... },
//       trades:[{ entry:{id:'BUY'|'SELL',price,time(ms),type}, exit:{...},
//                 profit:{value,percentValue}, cumulativeProfit:{value,percentValue},
//                 drawdown:{...}, runup:{...}, quantity, tradeNumber }, ...],
//       filledOrders:[..], activeOrders:[..], firstTradeIndex }
//   - *Percent fields are FRACTIONS (0.0159 = 1.59%). Trade/dateRange times are
//     Unix MILLISECONDS (the replay engine uses seconds — different units, don't mix).

const ACTIONS = ['report', 'trades', 'status'] as const;

// Evaluate `body` with `bt` (Strategy Tester controller) and `val` (WatchedValue
// unwrapper) in scope; `body` must `return` a JSON-serialisable value. Timeout-guarded.
async function runBacktest(page: any, body: string, timeoutMs = 25000): Promise<any> {
  const raw = await page.evaluate<string>(`new Promise((resolve) => {
    const val = (x) => { try { return (x && typeof x.value === 'function') ? x.value() : x; } catch (e) { return null; } };
    (async () => {
      try {
        const api = window.TradingViewApi;
        const bt = await api.backtestingStrategyApi.call(api);
        const r = await (async () => { ${body} })();
        resolve(JSON.stringify({ ok: true, r }));
      } catch (e) { resolve(JSON.stringify({ ok: false, error: (e && e.message) || String(e) })); }
    })();
    setTimeout(() => resolve(JSON.stringify({ ok: false, error: 'timeout' })), ${timeoutMs});
  })`);
  return JSON.parse(raw);
}

const NOSTRAT = 'Load a strategy first: tradingview indicator add --pine "PUB;<hash>" --pine-version <v>  (find one: tradingview pine "<q>" --kind strategy)';

// number -> fixed-2 string, blank for null/undefined/NaN.
const n2 = (x: any): string =>
  typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : '';
// fraction -> percent string (0.0159 -> "1.59%").
const pct = (x: any): string =>
  typeof x === 'number' && Number.isFinite(x) ? (x * 100).toFixed(2) + '%' : '';
// Unix milliseconds -> ISO, blank for null/0.
const fmtMs = (ms: any): string =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : '';

cli({
  site: 'tradingview',
  name: 'backtest',
  description: 'Read the Strategy Tester backtest report (net profit, win rate, drawdown, sharpe, trades) for the strategy loaded on the bound chart',
  access: 'read',
  domain: TRADINGVIEW_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'action', positional: true, default: 'report', help: `one of: ${ACTIONS.join('|')}`, choices: [...ACTIONS] },
    { name: 'limit', help: 'trades: max trades to show, most-recent first (default 50, max 500)' },
  ],
  columns: ['metric', 'value'],
  func: async (page, kwargs) => {
    const action = String(kwargs.action ?? 'report');
    await ensureChart(page);

    if (action === 'status') {
      const res = await runBacktest(
        page,
        `const rep = val(bt.activeStrategyReportData);
         const strat = val(bt.activeStrategy);
         const st = val(bt.activeStrategyStatus);
         return {
           empty: val(bt.isStrategyEmpty),
           statusType: st && st.type,
           name: strat && strat.shortDescription,
           count: Array.isArray(val(bt.allStrategies)) ? val(bt.allStrategies).length : 0,
           hasReport: !!rep,
           totalTrades: rep && rep.performance && rep.performance.all ? rep.performance.all.totalTrades : null,
         };`,
      );
      if (!res.ok) throw new ArgumentError(`backtest status failed: ${res.error}`, 'Confirm the chart is loaded.');
      const r = res.r;
      return [
        { metric: 'strategyLoaded', value: r.empty ? 'no' : 'yes' },
        { metric: 'strategyName', value: r.name ?? '' },
        { metric: 'strategiesOnChart', value: String(r.count ?? 0) },
        { metric: 'reportReady', value: r.hasReport ? 'yes' : 'no' },
        { metric: 'statusType', value: r.statusType != null ? String(r.statusType) : '' },
        { metric: 'totalTrades', value: r.totalTrades != null ? String(r.totalTrades) : '' },
      ];
    }

    if (action === 'trades') {
      let limit = kwargs.limit != null ? Number(kwargs.limit) : 50;
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      limit = Math.min(Math.floor(limit), 500);
      const res = await runBacktest(
        page,
        `// poll briefly in case the report is still computing after a fresh load
         let rep = null;
         for (let i = 0; i < 16; i++) { rep = val(bt.activeStrategyReportData); if (rep) break; await new Promise((r) => setTimeout(r, 500)); }
         if (!rep) return { empty: true };
         const t = Array.isArray(rep.trades) ? rep.trades : [];
         const slice = t.slice(-${limit}).reverse();
         return { empty: false, total: t.length, trades: slice.map((x) => ({
           n: x.tradeNumber,
           side: x.entry && x.entry.id,
           et: x.entry && x.entry.time, ep: x.entry && x.entry.price,
           xt: x.exit && x.exit.time, xp: x.exit && x.exit.price,
           pnl: x.profit && x.profit.value, pnlPct: x.profit && x.profit.percentValue,
           cum: x.cumulativeProfit && x.cumulativeProfit.value,
         })) };`,
      );
      if (!res.ok) throw new ArgumentError(`backtest trades failed: ${res.error}`, 'Confirm a strategy is loaded and its backtest has computed.');
      if (res.r.empty) throw new ArgumentError('no active strategy report', NOSTRAT);
      const t = res.r.trades as any[];
      if (!t.length) return [{ metric: 'trades', value: '0 (strategy has no closed trades on the loaded range)' }];
      return t.map((x) => ({
        metric: `#${x.n} ${x.side}`,
        value: `entry ${fmtMs(x.et)} @${n2(x.ep)} | exit ${fmtMs(x.xt)} @${n2(x.xp)} | pnl ${n2(x.pnl)} (${pct(x.pnlPct)}) | cum ${n2(x.cum)}`,
      }));
    }

    // report
    const res = await runBacktest(
      page,
      `// poll briefly in case the backtest is still computing after a fresh load
       let r = null;
       for (let i = 0; i < 16; i++) { r = val(bt.activeStrategyReportData); if (r) break; await new Promise((rs) => setTimeout(rs, 500)); }
       if (!r) return { empty: true };
       const p = r.performance || {};
       const a = p.all || {};
       const strat = val(bt.activeStrategy);
       const dr = r.settings && r.settings.dateRange && r.settings.dateRange.backtest;
       return {
         empty: false,
         name: strat && strat.shortDescription,
         currency: r.currency,
         initialCapital: p.initialCapital,
         netProfit: a.netProfit, netProfitPercent: a.netProfitPercent,
         grossProfit: a.grossProfit, grossLoss: a.grossLoss,
         profitFactor: a.profitFactor,
         percentProfitable: a.percentProfitable,
         totalTrades: a.totalTrades, wins: a.numberOfWiningTrades, losses: a.numberOfLosingTrades,
         avgTrade: a.avgTrade, avgWin: a.avgWinTrade, avgLoss: a.avgLosTrade,
         ratioAvgWinAvgLoss: a.ratioAvgWinAvgLoss,
         largestWin: a.largestWinTrade, largestLoss: a.largestLosTrade,
         commissionPaid: a.commissionPaid, maxContractsHeld: a.maxContractsHeld,
         returnOnAccount: a.returnOnAccount, annualizedReturn: a.annualizedReturn, expectedPayoff: a.expectedPayoff,
         sharpe: p.sharpeRatio, sortino: p.sortinoRatio,
         maxDrawdown: p.maxStrategyDrawDown, maxDrawdownPercent: p.maxStrategyDrawDownPercent,
         buyHoldReturn: p.buyHoldReturn, buyHoldReturnPercent: p.buyHoldReturnPercent,
         from: dr && dr.from, to: dr && dr.to,
       };`,
    );
    if (!res.ok) throw new ArgumentError(`backtest report failed: ${res.error}`, 'Confirm a strategy is loaded and its backtest has computed.');
    if (res.r.empty) throw new ArgumentError('no active strategy report', NOSTRAT);
    const r = res.r;
    const cur = r.currency ? ` ${r.currency}` : '';
    return [
      { metric: 'strategy', value: r.name ?? '' },
      { metric: 'dateRange', value: `${fmtMs(r.from)} -> ${fmtMs(r.to)}` },
      { metric: 'initialCapital', value: `${n2(r.initialCapital)}${cur}` },
      { metric: 'netProfit', value: `${n2(r.netProfit)}${cur} (${pct(r.netProfitPercent)})` },
      { metric: 'grossProfit', value: `${n2(r.grossProfit)}${cur}` },
      { metric: 'grossLoss', value: `${n2(r.grossLoss)}${cur}` },
      { metric: 'profitFactor', value: n2(r.profitFactor) },
      { metric: 'percentProfitable', value: pct(r.percentProfitable) },
      { metric: 'totalTrades', value: `${r.totalTrades ?? ''} (${r.wins ?? '?'}W / ${r.losses ?? '?'}L)` },
      { metric: 'avgTrade', value: `${n2(r.avgTrade)}${cur}` },
      { metric: 'avgWin / avgLoss', value: `${n2(r.avgWin)} / ${n2(r.avgLoss)}${cur} (ratio ${n2(r.ratioAvgWinAvgLoss)})` },
      { metric: 'largestWin / largestLoss', value: `${n2(r.largestWin)} / ${n2(r.largestLoss)}${cur}` },
      { metric: 'maxDrawdown', value: `${n2(r.maxDrawdown)}${cur} (${pct(r.maxDrawdownPercent)})` },
      { metric: 'sharpe / sortino', value: `${n2(r.sharpe)} / ${n2(r.sortino)}` },
      { metric: 'returnOnAccount', value: pct(r.returnOnAccount) },
      { metric: 'annualizedReturn', value: pct(r.annualizedReturn) },
      { metric: 'expectedPayoff', value: `${n2(r.expectedPayoff)}${cur}` },
      { metric: 'maxContractsHeld', value: r.maxContractsHeld != null ? String(r.maxContractsHeld) : '' },
      { metric: 'commissionPaid', value: `${n2(r.commissionPaid)}${cur}` },
      { metric: 'buyHoldReturn', value: `${n2(r.buyHoldReturn)}${cur} (${pct(r.buyHoldReturnPercent)})` },
    ];
  },
});

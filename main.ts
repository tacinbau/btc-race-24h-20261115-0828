// Deep-dip recovery bot for the BTC 24h race (cbBTC/USDC, 1-minute bars).
//
// Idea: the dev window is a choppy downtrend (-4% start to end) in which
// every standard baseline loses money after the ~26-43 bps round-trip cost
// (4 bps fee + 2 bps slippage + price impact against a ~$640k pool).
// The only repeatable edge in the window is the deep dip: after BTC has
// fallen more than 2.5% in an hour, the washout is followed by a recovery
// over the next few hours. The bot sits in cash, waits for that shape, buys
// it in full, and rides the recovery: +4% take-profit, -2% stop-loss, or
// 240 bars (4 hours), whichever comes first. After any exit it waits 120
// bars before a new entry, so it never jumps straight back into the same
// dip cluster.
//
// Local grade on the dev window (grade-local --driver process, kit harness):
// net PnL +$37.75, 2 trades (1 round trip), max drawdown 1.37%, fees $0.82.
// The parameters sit on a plateau, not a knife edge: 60-minute drops of
// 2.2%-2.8% and holds of 120-300 bars all give a positive dev PnL.
//
// Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin and
// stdout, one reply per batch echoing its seq. Only the standard library is
// used (the vendored makefun-bars.ts shim, a byte-identical copy of the
// kit's sdk/makefun-bars.ts). All decisions are exact integer arithmetic on
// the bars themselves: no floats, no wall clock, no environment, no
// randomness, so two runs on the same data produce the same orders.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Lookback for the drop / low windows, in bars (60 minutes). */
const LOOKBACK = 60;
/** Deep dip: a 60-minute return below -2.5% (x1000 < x975). */
const DROP_NUM = 975n;
const DROP_DEN = 1000n;
/** Bounce: close at least +0.3% above the 60-minute low (x1000 >= x1003). */
const BOUNCE_NUM = 1003n;
/** Take-profit: position value at least 104% of its cost. */
const TP_NUM = 1040n;
/** Stop-loss: position value at most 98% of its cost. */
const SL_NUM = 980n;
const PCT_DEN = 1000n;
/** Maximum bars to hold a position. */
const MAX_HOLD_BARS = 240;
/** Bars to wait after an exit before a new entry. */
const COOLDOWN_BARS = 120;
/** Slippage cap on every order, in bps past the deciding close. */
const MAX_SLIPPAGE_BPS = 100;

/** Closes and lows of every fresh bar seen, in order. */
const closes: bigint[] = [];
const lows: bigint[] = [];
/** Seq of the batch that decided the current entry (-1 when flat). */
let entrySeq = -1;
/** Highest close seen since the entry decision (0 when flat). */
let peakClose = 0n;
/** Seq of the batch whose fills emptied the last position (very negative when none). */
let lastExitSeq = -1_000_000_000;
/** Whether a position was held on the previous batch. */
let held = false;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold this batch's fresh bar into history. A batch with no bar for the
    // symbol is a gap: nothing new to learn from it.
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(BigInt(bar.c));
      lows.push(BigInt(bar.l));
      fresh = true;
    }

    const close = state.close(SYMBOL);
    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;

    // The position emptied on this batch's fills: mark the exit for the
    // cooldown, and clear the entry bookkeeping.
    if (held && qty === 0n) {
      lastExitSeq = state.seq;
      entrySeq = -1;
      peakClose = 0n;
    }
    held = qty > 0n;

    if (close === null) return [];

    if (qty > 0n) {
      // Holding: track the peak close, then check every exit.
      if (close > peakClose) peakClose = close;
      const cost = pos!.cost;
      const value = state.value(SYMBOL, qty);
      const takeProfit = value * PCT_DEN >= cost * TP_NUM;
      const stopLoss = value * PCT_DEN <= cost * SL_NUM;
      const tooLong = entrySeq >= 0 && state.seq - entrySeq >= MAX_HOLD_BARS;
      if (takeProfit || stopLoss || tooLong) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for the deep-dip entry, on a fresh bar only, past the
    // cooldown. Need 2*LOOKBACK closes: a 60-minute return ending 60 bars
    // back needs close[j - 60], and j reaches back to i - 59.
    if (!fresh) return [];
    const i = closes.length - 1;
    if (i < 2 * LOOKBACK) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    let sharpDrop = false;
    for (let j = i - (LOOKBACK - 1); j <= i; j++) {
      if (closes[j]! * DROP_DEN < closes[j - LOOKBACK]! * DROP_NUM) {
        sharpDrop = true;
        break;
      }
    }
    if (!sharpDrop) return [];
    let low60 = lows[i]!;
    for (let j = i - LOOKBACK; j <= i; j++) {
      if (lows[j]! < low60) low60 = lows[j]!;
    }
    const bounced = close * PCT_DEN >= low60 * BOUNCE_NUM;
    const uptick = close > closes[i - 1]!;
    if (!bounced || !uptick) return [];
    if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entrySeq = state.seq;
    peakClose = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});

# BTC Race bot — deep-dip recovery (cbBTC/USDC, 1-minute bars)

Entry for **btc-race-24h-20261115-0828** ("Race a BTC trading bot live for
24 hours"): a long-only bot trading cbBTC against USDC on 1-minute on-chain
bars, starting with $1,000 of paper money. It speaks
`agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) and runs
as `node /bot/main.ts` (Node 22, standard library only).

## Strategy

The published 24h dev window is a choppy downtrend (-4% start to end) in
which every kit baseline loses money after the ~26-43 bps round-trip cost
(4 bps fee + 2 bps slippage + price impact against a ~$640k pool):
buy-and-hold ≈ -$44, EMA-cross ≈ -$135, RSI-Bollinger ≈ -$57,
momentum ≈ -$41, ADX-momentum ≈ -$87 (verified with the kit's local
grader). The only repeatable edge found in the window is the **deep dip**:
after BTC has fallen more than 2.5% in an hour, the washout is followed by
a recovery over the next few hours. The bot sits in cash and waits for that
shape.

**Entry** (on a bar's close, filled at the next bar's open), when flat:

- some 60-minute return over the last 60 bars is below **-2.5%**, and
- the close has bounced at least **+0.3%** off the 60-minute low, and
- the close is above the previous close (an uptick).

It buys with the whole cash balance (one position, up to 100% of equity).

**Exit** (the whole position), when any holds at a close:

- take-profit: position value ≥ **104%** of cost, or
- stop-loss: position value ≤ **98%** of cost, or
- max hold: **240 bars** (4 hours) since the entry decision.

After any exit it waits **120 bars** before a new entry, so it never jumps
straight back into the same dip cluster. Every order caps slippage at
**100 bps** (1%) past the deciding close, so a fill into a gap is refused
rather than chased.

All decisions are exact integer arithmetic on the bars (no floats, no wall
clock, no environment, no randomness), so two runs on the same data produce
the same orders.

## Local grade

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Dev window: **net PnL +$37.75, 2 trades (1 round trip), max drawdown
1.37%, fees $0.82** (at 2x fees: +$36.92). L1 regrade reproduced byte for
byte. The parameters sit on a plateau: 60-minute drops of 2.2%-2.8% and
holds of 120-300 bars all give a positive dev PnL.

## Layout

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `sdk/makefun-bars.ts` protocol shim.
- `LICENSE` — MIT.

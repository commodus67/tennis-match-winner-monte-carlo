# ATP/WTA Tennis Match Winner Monte Carlo + Kalshi

Live and upcoming ATP and WTA singles matches, projected with a Monte Carlo
model built on each player's current ranking points, compared against
[Kalshi](https://kalshi.com) `KXATPMATCH` / `KXWTAMATCH` prediction-market
prices to surface edge.

## What it does

For every singles match on today's ATP and/or WTA scoreboard:

1. Pulls both players' current ATP/WTA ranking points.
2. Estimates a pre-match win probability with a Bradley-Terry model on those
   points (calibrated against live Kalshi prices).
3. If the match is already in progress, converts that pre-match probability
   into an equivalent per-set probability and Monte Carlo-simulates the sets
   remaining from the current score — so a player already up a set shows a
   higher win probability than the pre-match number, without needing
   point-by-point data.
4. Optionally fetches the live Kalshi market for that match and reports the
   model's edge over the market price, a VALUE/WATCH verdict, and a
   suggested (half-Kelly by default) stake sized to your bankroll.

## Output

One row per player per match. Key fields: `player`, `opponent`,
`winProbability`, `method` (`pre-match` or `live-simulation`), and, when
market comparison is on, `kalshiYesAsk`, `edge`, `verdict`
(`VALUE`/`WATCH`/`NO_MARKET`/`ILLIQUID`) and `suggestedStake`.

Two dataset views: **Match overview** (probabilities only) and **Market
edge** (the Kalshi comparison columns).

## Input

See the input schema for the full list. The defaults run both tours, compare
against Kalshi, and use half-Kelly sizing with no bankroll set (so you get
edges without stake suggestions until you set one).

## Method notes

- **Strength**: live ATP/WTA ranking points (`site.api.espn.com`), not a
  full-season stat line — there's no separate strength signal to fall back
  on for tennis the way there is for a team's point differential.
- **Format**: best-of-3 everywhere except the men's Grand Slams
  (Australian Open, Roland Garros, Wimbledon, US Open), which are best-of-5.
  Every WTA event, including the women's Slams, is best-of-3.
- **Uncertainty**: the raw ranking-based probability is blended toward a
  coin flip by `strengthUncertainty` (default 0.15) to hedge against
  surface, current form, H2H and injuries — none of which ranking points
  alone can see.
- Qualifying-round matches are excluded by default (`includeQualifying`),
  since they rarely have a Kalshi market to compare against.

This Actor is a research tool. It does not place trades and is not
financial advice.

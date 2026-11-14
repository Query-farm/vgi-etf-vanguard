# Vanguard: paired NAV and market-price observations

[Open the executed notebook](01_nav_market_price_band.ipynb). It retrieves live
daily one-year histories for VOO and BND, calculates market-minus-NAV differences
in basis points, and studies how a symmetric threshold changes the flagged count.
The time plot retains extremes, and the empirical threshold curve retains every
valid observation in its denominator.

## Run from this directory

Install [uv](https://docs.astral.sh/uv/), then:

```bash
uv sync --frozen
uv run python execute.py
```

The locked notebook environment uses Python 3.13–3.14 and published Haybarn
2.0.0rc11. Visible SQL attaches
`github-auto://Query-farm/vgi-etf-vanguard@v0.4.0`, downloading the corresponding
published native worker. No Bun installation, local worker build, worker checkout,
API key or globally registered kernel is required. Internet access to GitHub,
community extensions and Vanguard is required. This is live retrieval without a
fixture fallback; source failures are reported as failures.

For a notebook editor, register and select this environment:

```bash
uv run python -m ipykernel install --user --name vanguard-examples \
  --display-name "Python (vgi-etf-vanguard notebooks)"
```

SQL and parameters stay visible; setup and plotting source are folded. Restart and
run all after editing parameters. This directory includes its relative helpers and
assets and runs after being copied outside the repository.

## Experiment

```bash
uv run python execute.py --parameters '{"BAND_BPS":5.0}' \
  --output-dir validation/band-5
```

The default is 10.0 bp; the accepted range is 0.5–50 bp. An observation is flagged
only when its absolute difference is strictly greater than the threshold. For
unchanged input, tightening the band from 10 to 5 bp cannot reduce that count.
Prices, sample size, median and maximum should stay unchanged. Restore 10.0 for
the default. Fresh execution retrieves the rolling window again, so compare actual
dates and values and allow for same-date revisions.

The runner starts a fresh kernel, saves only after success, and requires a separate
output directory for overrides. Experiment copies receive execution and branding
companions. Generated validation artifacts are ignored.

## Source and calculation

The real worker reads Vanguard's public catalog and `1Y` price histories for
[VOO](https://investor.vanguard.com/investment-products/etfs/profile/voo) and
[BND](https://investor.vanguard.com/investment-products/etfs/profile/bnd). Each object
is materialized once before local DataFrame captures. The notebook displays a UTC
retrieval clock and actual returned date ranges. The fixed `1Y` period is daily;
`5Y` and `10Y` sample less frequently and would answer a different question.

The worker iterates NAV dates and joins market prices by calendar date. Market-only
dates do not appear, and these results are not a complete exchange calendar.
Missing, nonfinite or nonpositive pairs are diagnosed and excluded from ratio
denominators. No missing values are replaced with zero and no dates are interpolated.

Both price columns are reported USD per share. The calculation is
`10000 * (market_price - nav) / nav`; one basis point is 0.01 percentage point.
Positive means market price exceeds NAV, and negative means it is below NAV.
The threshold curve shows cutoffs up to at least 15 bp, while counting all valid
observations, including larger departures. Its knots include the observed absolute
differences, so the steps represent the empirical sample precisely.

Same-date records do not prove identical valuation times or executable prices.
Separate fund responses are not atomic. The notebook cannot establish an economic
cause, an arbitrage opportunity or transaction costs; it includes no distributions
or reinvestment and does not measure total return. This is a descriptive SQL example.

Upgrade by editing the literal worker release pin and verifying both runs with
the locked engine. [STANDARD.md](STANDARD.md) records the notebook conventions.

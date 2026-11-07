# vgi-etf-vanguard

A [VGI](https://query.farm) worker that exposes **Vanguard** US ETF data as DuckDB tables and
table functions — the ETF product catalog, a fund-partitioned holdings table, a wide per-fund
characteristics snapshot, and per-fund distribution and NAV/price history.

| Object | What it returns | Vanguard source |
| --- | --- | --- |
| `vanguard.products` (table) | Every US ETF with key facts, one row per fund | `list/funddetail/all` catalog |
| `vanguard.holdings` (table) | Detailed current holdings, partitioned by fund_ticker | `irr/funds/profile/<T>-AdditionalFundData` |
| `vanguard.fund_details(fund)` | Wide one-row characteristics snapshot | `irr/funds/profile/<T>.json` |
| `vanguard.distributions(fund, start_date, end_date)` | Recent distribution (dividend) history | `irr/funds/profile/<T>.json` |
| `vanguard.nav_history(fund, period)` | NAV + market-price series over a look-back window | `vmf/api/<T>/price-history/<period>` |

Everything rides Vanguard's public JSON planes — there is no secret to create and no login.
Funds are identified by their exchange **ticker** (e.g. `VOO`); the fund-scoped functions resolve
a ticker via one cached catalog lookup.

Two conventions to know:
- **Dates are real `DATE` columns** (no timezone) — compare them directly, e.g.
  `WHERE record_date >= DATE '2025-01-01'`.
- **Percent columns carry a `_percent` suffix and hold percent points**: `expense_ratio_percent`
  = 0.03 means 0.03%; `weight_percent` = 7.89 means 7.89% (weights sum to ~100). `beta` and
  `r_squared` are ratios, so they are **not** suffixed.

> **Holdings are current-only.** Vanguard publishes a single as-of date per fund, so the
> `holdings` table has **no time travel** (unlike some other providers) — the `as_of_date` column
> reflects Vanguard's reported date.

> **Status:** initial build. Unit tests (SDK-free driver + Arrow batch builders), own-source
> typecheck, a live HTTP-transport smoke test, the haybarn SQLLogic E2E suite against a real
> DuckDB + the community `vgi` extension, and a `vgi-lint` metadata gate at 100/100 all pass.

## Quick start

Every [GitHub release](https://github.com/Query-farm/vgi-etf-vanguard/releases) ships a prebuilt worker binary. The `vgi` extension downloads the one for your platform, checks its SHA-256 and caches it, so there is nothing to install besides DuckDB:

```sql
INSTALL vgi FROM community;
LOAD vgi;

ATTACH 'vanguard' AS vanguard (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-etf-vanguard@v0.2.0');

-- The cheapest Vanguard ETFs by expense ratio
SELECT ticker, long_name, expense_ratio_percent FROM vanguard.main.products ORDER BY expense_ratio_percent LIMIT 5;

-- The top holdings of the Vanguard S&P 500 ETF
SELECT ticker, name, weight_percent FROM vanguard.main.holdings WHERE fund_ticker = 'VOO' ORDER BY weight_percent DESC LIMIT 5;
```

Prebuilt binaries cover macOS (Apple silicon), Linux (x86-64 and arm64). `github-auto://` needs an explicit release tag; change `@v0.2.0` to move to a newer release.

### Other ways to run it

- **Docker** (the image bundles the worker; needs a container runtime):

  ```sql
  ATTACH 'vanguard' AS vanguard (TYPE vgi, LOCATION 'docker://ghcr.io/query-farm/vgi-etf-vanguard:0.2.0');
  ```

- **Manual download.** Download the archive for your platform from the [releases page](https://github.com/Query-farm/vgi-etf-vanguard/releases), verify it against its `.sha256` file (a cosign `.cosign.bundle` is published alongside), unpack it, and set `LOCATION` to the path of the extracted worker executable.

- **HTTP server.** Run the image's HTTP transport yourself and attach it by URL:

  ```bash
  docker run --rm -p 8000:8000 ghcr.io/query-farm/vgi-etf-vanguard:0.2.0   # serves /health + the VGI RPC on :8000
  ```

  ```sql
  ATTACH 'vanguard' AS vanguard (TYPE vgi, LOCATION 'http://localhost:8000');
  ```

### Build from source

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'vanguard' AS vanguard (TYPE vgi, LOCATION '/path/to/vgi-etf-vanguard/bin/vgi-etf-vanguard-worker');
```

`bin/vgi-etf-vanguard-worker` is a small wrapper that launches `src/worker.ts` under Bun.

Tests, typecheck and the E2E suite are described under [Development](#development).

## Usage

### products — the ETF catalog (a base table)

`products` is a plain **table** — no arguments, no parentheses. It returns the whole ETF lineup;
filter with `WHERE`.

```sql
-- Cheapest Vanguard ETFs by expense ratio:
SELECT ticker, long_name, expense_ratio_percent
FROM vanguard.products
ORDER BY expense_ratio_percent
LIMIT 10;

-- Bond ETFs with their 1-year return:
SELECT ticker, long_name, return_1y_percent
FROM vanguard.products
WHERE asset_class = 'Fixed Income'
ORDER BY return_1y_percent DESC;

-- Look up one fund by ticker:
SELECT ticker, long_name, expense_ratio_percent
FROM vanguard.products
WHERE ticker = 'VOO';
```

Filter on `ticker`, `asset_class` (`'Equity'`, `'Fixed Income'`, …), `management_style`
(`'Index'`/`'Active'`), etc. Columns include `ticker`, `fund_id`, `cusip`, `short_name`/
`long_name`, `asset_class`/`category`/`style`, `inception_date` (DATE), `expense_ratio_percent`,
`price`/`market_price` and `price_as_of` (DATE), `yield_percent`, and the annualized
`return_*_percent` (1m/3m/1y/3y/5y/10y/since inception), plus `risk_level`/`risk_code` and
`primary_benchmark`. All `*_percent` columns are in percent points (0.03 = 0.03%).

### holdings — a fund-partitioned table (current-only)

`holdings` is a **table hive-partitioned by `fund_ticker`** (the fund's ticker). Filter
`fund_ticker` to pick funds, or scan without a filter to stream **every** fund's holdings (one
partition per fund — over a hundred funds, so prefer a filter).

```sql
-- Top 10 current holdings of VOO (already weight-ordered):
SELECT ticker, name, weight_percent, market_value
FROM vanguard.holdings
WHERE fund_ticker = 'VOO'
ORDER BY weight_percent DESC
LIMIT 10;

-- Several funds at once (partition fan-out):
SELECT fund_ticker, ticker, weight_percent
FROM vanguard.holdings
WHERE fund_ticker IN ('VOO', 'VTI');

-- Every fund at once (streams all partitions — slow; each fund is a partition):
SELECT fund_ticker, count(*) AS n
FROM vanguard.holdings
GROUP BY fund_ticker;

-- A bond fund also fills coupon / maturity / face:
SELECT name, coupon_percent, maturity, face_amount, weight_percent
FROM vanguard.holdings
WHERE fund_ticker = 'BND'
LIMIT 5;
```

`fund_ticker` is the **fund's** ticker and the hive partition key — distinct from the `ticker`
column (each row's own constituent ticker, empty when Vanguard has none). Vanguard reports a
single as-of date per fund (the `as_of_date` column); there is **no time travel**. Rows come back
**weight-descending**. Join `holdings.fund_ticker` to `products.ticker` for fund-level facts.
Columns: `fund_ticker`, `as_of_date` (DATE), `name`, `ticker`, `isin`, `cusip`, `sedol`,
`weight_percent`, `market_value`, `shares_held`, `notional_value`, `sec_type` (e.g. `EQ.STOCK`,
`FI.US_GOV`, `MM.CASH`, `DE.IND` — every holding group is included, cash and futures too), plus
the debt-only `coupon_percent`, `maturity` (raw MM/DD/YYYY text), and `face_amount`.

> A backing `holdings_scan()` function is also exposed (it's what the table scans, and it's what
> lets DuckDB push the `fund_ticker` filter) — prefer the `holdings` table.

### fund_details — one-row characteristics snapshot

```sql
SELECT ticker, primary_benchmark, beta, r_squared, expense_ratio_percent, yield_percent
FROM vanguard.fund_details('VOO');
```

Adds facts beyond `products`: premium/discount, 52-week high/low band, the primary benchmark and
its 1-year return, and beta / R-squared / risk level.

```sql
SELECT ticker, premium_discount_percent, high_52w_price, low_52w_price
FROM vanguard.fund_details('VOO');
```

### distributions — dividend history

```sql
-- Recent distributions:
SELECT record_date, distribution_type, per_share_amount
FROM vanguard.distributions('VOO')
ORDER BY record_date DESC
LIMIT 8;

-- Total distributions over the trailing year:
SELECT sum(per_share_amount) AS total
FROM vanguard.distributions('VOO', start_date := (CURRENT_DATE - INTERVAL 1 YEAR)::DATE);
```

Amounts are **per-share dollars**, not percentages. `start_date`/`end_date` bound the record-date
range (inclusive SQL `DATE`s; omit for unbounded). Vanguard publishes only a **rolling** window of
about the trailing 18 months (~6 payouts for a quarterly payer, ~18 for a monthly one), so derive
your bounds from `CURRENT_DATE` — a hard-coded calendar year returns no rows once the window moves
past it.

### nav_history — NAV & market-price series

```sql
-- Daily NAV over the past year:
SELECT as_of_date, nav, market_price
FROM vanguard.nav_history('VOO', period := '1Y')
ORDER BY as_of_date DESC;

-- 10-year series (monthly points):
SELECT as_of_date, nav
FROM vanguard.nav_history('VOO', period := '10Y')
ORDER BY as_of_date;
```

`period` picks the look-back window — one of `1M`, `1Y`, `5Y`, `10Y` (default `1Y`). Shorter
windows are daily; longer windows thin to weekly (`5Y`) or monthly (`10Y`). This is **fund NAV**
(and the exchange market price), not an intraday candle series.

## Development

```bash
bun install
bun test            # unit tests (SDK-free driver + Arrow batch builders + live HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install --prerelease allow 'haybarn-unittest>=2.0.0rc11,<2.1'
echo "INSTALL vgi FROM community;" | uvx --prerelease allow --from 'haybarn-cli>=2.0.0rc11,<2.1' haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check); CI runs
it as a gate at 100/100. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-etf-vanguard-worker --fail-on info
```

The pure request/response logic lives in `src/vanguard.ts` and is fully unit-tested against an
in-process fake (`test/fake-vanguard.ts`) — no network. The single module that touches the network
is `src/client.ts` (it sets the browser-like User-Agent Vanguard requires); it is verified live
rather than in the unit suite.

## Layout

```
src/vanguard.ts   Pure driver: URL builders + JSON parsers + fetch orchestrators (no network, no SDK)
src/client.ts     Real fetch client (browser User-Agent; keyless)
src/schema.ts     Typed Arrow output schemas + row→batch builders
src/functions.ts  The table-function / backing-scan definitions
src/catalog.ts    The `vanguard` catalog descriptor (no secret type)
src/worker.ts     Worker entry: wires the real client into the functions
bin/…-worker      Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from Vanguard's public product website JSON endpoints (the funddetail catalog and the
per-fund profile/price/holdings/distribution APIs). It is provided for personal, informational use;
consult Vanguard's terms before any redistribution or commercial use. This worker is not affiliated
with or endorsed by The Vanguard Group.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm

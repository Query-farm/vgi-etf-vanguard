# vgi-etf-vanguard — agent notes

A VGI (DuckDB) worker exposing **Vanguard** US ETF data as two base **tables** — `products` (the
catalog) and `holdings` (fund-partitioned, current-only) — plus table **functions**:
`fund_details`, `distributions`, `nav_history` (and the listed `holdings_scan` backing the
holdings table). TypeScript, runs on Bun, built on `@query-farm/vgi` (the TS SDK). Keyless — no
secret type, no auth. Modeled on the sibling `vgi-etf-ishares` worker.

## Base tables (`products`, `holdings`) — two layers: registry vs listing

Tables are wired via `SchemaDescriptor.tables` (`makeCatalog`'s `tables: [...]`); each
`TableDescriptor` has `function: <scan>` + `arguments: new Arguments([], new Map())` and carries
its docs on `tags`/`comment`/`columnComments`. Two INDEPENDENT layers matter:
- **FunctionRegistry** (`registry.register(scan)`) — the *dispatch* layer. Required for the table
  to be scannable.
- **catalog `schemas[].functions`** — the *listing* layer (DuckDB's `schemaContentsFunctions`).
  Controls what shows as a callable `X()` function AND is where the extension discovers a scan's
  capabilities (e.g. `filter_pushdown`).

`products`: backing `productsScan` is **registered but NOT listed** → exposed only as the table,
and it needs no pushdown. `holdings`: backing `holdingsScan` MUST be **listed**
(`functions: [...functions, holdingsScan]`) — proven in the sibling iShares worker that an unlisted
backing scan gets **no** `pushdown_filters` (the extension can't see its `filter_pushdown`
capability), so the `fund_ticker` partition filter never reaches it. Hence a visible
`holdings_scan()` function is unavoidable; VGI311 is waived in `vgi-lint.toml`.

## `holdings` — hive-partitioned by `fund_ticker`, CURRENT-only (NO time travel)

Query `FROM vanguard.main.holdings WHERE fund_ticker = 'VOO'` (fund selector); an **unfiltered
scan streams every fund** (one partition per fund). Mechanics (mirror iShares' scan):
- **Hive partitioning + streaming queue.** `holdingsScan` is a `partitionKind:
  "SINGLE_VALUE_PARTITIONS"` generator — `fund_ticker` is the partition key (annotated
  `vgi.partition_column` in `holdingsSchema`). `onInit` reads the pushed `fund_ticker` filter (or,
  absent one, the whole ETF catalog), and `queuePush`es one item per fund (`{ticker, isBond}`) onto
  a `BoundStorage` queue keyed by the execution id. `process()` pops one fund per tick, fetches its
  holdings, and `out.emit`s a single partition batch tagged with `vgi_partition_values`
  (min==max==ticker). `maxWorkers` workers drain the same queue → work-stealing fan-out. `LIMIT`
  short-circuits the stream, so `SELECT * FROM holdings LIMIT 5` fetches only ~1 fund.
- **No `requiredFieldFilterPaths`** — a bare scan defaults to ALL funds. Pushdown still narrows it:
  `onInit` reads `deserializeFilters(...).getColumnValues("fund_ticker")` (equality/IN).
- **`filterPushdown: true`** on `holdingsScan` + LISTED → the extension pushes the filter in.
- **NO `supportsTimeTravel`.** Vanguard publishes only the current holdings for a fund (one
  reported as-of date), so there is no AT coordinate and the scan reads no `p.atValue`. This is the
  key intentional difference from vgi-etf-ishares. The source's reported as-of date is still surfaced
  as the `as_of_date` output column.
- **`fund_ticker` is a SEPARATE column from `ticker`** — `ticker` is the CONSTITUENT's own ticker
  (empty for aggregated bond lots); `fund_ticker` is the requested fund ticker, upper-cased, on
  every row. Constraints: `products` advisory PK `[ticker]`, `holdings` `notNull [fund_ticker]`
  (advisory PKs are NOT enforced on scan). No cross-table FK (ticker/cusip/etc. recur with
  different meanings), and VGI807/809 are waived in `vgi-lint.toml` with reasons.
- **Stock vs bond breakdown.** An equity fund's constituents live under `portfolio-holding/stock`,
  a bond fund's under `portfolio-holding/bond`. `onInit` stamps each queue item with `isBond` (from
  the catalog's `fundFact.isBond`) so `fetchHoldings` hits the right endpoint; if the primary comes
  back empty it falls back to the other (handles balanced/misclassified funds).

## Architecture (keep this separation)

- **`src/vanguard.ts` — the pure driver.** URL builders + JSON→row parsers, plus thin `fetch*`
  orchestrators and `resolveFund` that take an injected `get(url) => Promise`. NO network, NO SDK
  import. This is what the unit tests exercise. All parsing is defensive: a missing key/container/
  array degrades to `[]` / `null` cells, never a throw. `resolveFund` returns `string | null`
  (null = ticker not found) rather than throwing; `functions.ts` turns null into a typed
  `ArgumentValidationError`.
- **`src/client.ts` — the only network module.** `makeVanguardGet()` returns the real `get`. Its
  one job beyond `fetch` is setting the browser-like User-Agent Vanguard requires (the default
  fetch UA gets an interstitial HTML page instead of JSON). It memoizes the one ~4.8 MB
  `funddetail/all` catalog URL for 24 h (it backs both `products` and every ticker resolution);
  everything else always goes live. No dedicated unit test beyond the cache logic; exercised live
  by the HTTP-transport E2E test.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** ETF data has a stable shape, so we
  emit real typed columns (`Utf8`/`Float64`/`Int64`/`DateDay`), not JSON. Every calendar date is a
  real Arrow **DATE** (`DateDay` → DuckDB `DATE`, no timezone). `batchFromColumns` defaults to the
  **"rich"** representation, so a DATE cell is a **JS `Date`** (built at UTC midnight) and an Int64
  cell is a **bigint**. The driver returns dates as epoch seconds; the Date conversion lives only
  here. NOTE: dates are DATE, not TIMESTAMP — casting a UTC-midnight TIMESTAMPTZ `::DATE` shifts the
  day in non-UTC sessions. Percent columns carry a `_percent` suffix and hold **percent points**
  (`weight_percent` 7.89 = 7.89%, `expense_ratio_percent` 0.03 = 0.03%). Ratios that aren't
  percents (`beta`, `r_squared`) are NOT suffixed. `resultColumnsSchema()` builds the
  `vgi.result_columns_schema` tag DRY from an Arrow schema + a name→description map.
- **`src/functions.ts`** — five `defineTableFunction`s: `makeProductsScan` (unlisted products-table
  scan), `makeHoldingsScan` (listed holdings-table scan) plus `fund_details`, `distributions`,
  `nav_history`. Callable-function state is a `{done}` flag only (fully serializable → HTTP
  transport safe). Each function is a single-shot snapshot.
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the entry that
  wires the real client into the functions.

## Vanguard endpoint facts (why the design is what it is)

All keyless JSON, all need only the browser User-Agent:

1. **Catalog** — `GET /investment-products/list/funddetail/all` (~4.8 MB). Shape:
   `{size, self, fund: {entity: [...]}}`. Each entity nests `profile` (fundId, ticker, cusip,
   shortName, longName, inceptionDate, style, category, customizedStyle, expenseRatio, isETF,
   fundManagementStyle, `fundFact.{isStock,isBond,…}`), `risk` (code, level,
   `volatility.primaryBenchmarkName`), `dailyPrice.{regular,market}.{price,asOfDate}`,
   `yield.{yieldPct,asOfDate}`, `ytd.{regular,marketPrice}`, and
   `monthEndAvgAnnualRtn.fundReturn.{calendarYTDPct,prevMonthPct,threeMonthPct,oneYrPct,threeYrPct,
   fiveYrPct,tenYrPct,sinceInceptionPct}` (newer funds omit the longer horizons → null). Backs
   `products` (filtered to `profile.isETF`) and the ticker resolution in `resolveFund`. 383 total
   entities, ~116 ETFs.
2. **Per-fund profile API** — `GET /investment-products/etfs/profile/api/<TICKER>/<component>`:
   - `profile` → `{fundProfile: {…}}` (same fields as the catalog's `profile`, one fund).
   - `price` → `{currentPrice: {premiumOrDiscount, yield:{yieldPct,asOfDate},
     dailyPrice:{regular,market}, highLow.regular:{highPrice,lowPrice}}, historicalPrice:{…}}`.
   - `performance` → `{recentInvestmentRtn: {benchmarkShortName, fundReturn:{…annualized…},
     benchmarkReturn:{oneYrPct,…}}}`.
   - `risk` → `{code, level, volatility:{primaryBenchmarkName, betaPrimary, rSquaredPrimary, …}}`.
   - `distribution` → `{divCapGain:{distributionFrequency, item:[{type, perShareAmount ("$1.96"),
     recordDate, reinvestmentDate, payableDate, reinvestPrice}]}}` (recent history; no ex-date —
     Vanguard keys on the record date).
   - `portfolio-holding/{stock,bond}?start=1&count=50000` → `{size, asOfDate, fund:{entity:[…]}}`;
     each holding `{longName, shortName, sharesHeld, marketValue, ticker, isin, cusip, sedol,
     percentWeight, notionalValue, secMainType, secSubType}` plus, for bonds, `{couponRate,
     maturityDate (may be an aggregated "MM/DD/YYYY-MM/DD/YYYY" range → kept as raw text),
     faceAmount}`. Paginates at 500/page via a `next` link; we request a huge `count` to get every
     lot in one call.
3. **Price history** — `GET /vmf/api/<TICKER>/price-history/<PERIOD>` with PERIOD ∈ `1M/1Y/5Y/10Y`
   (`MAX`/`YTD`/`ALL` return empty). Shape: `{nav:[{item:[{asOfDate,price}]}],
   marketPrice:[{item:[…]}]}`. Backs `nav_history`, which zips nav+market by date. 1M/1Y are daily,
   5Y weekly, 10Y monthly.

**Values:** Vanguard returns numbers as JSON strings far more often than as numbers ("0.0300",
"$1.962200", "570.22", "-0.15"); `num()` strips `$`/`,`/`%`/spaces and parses. Dates arrive as ISO
timestamps with an offset ("2026-05-31T00:00:00-04:00"); `isoDate()` keeps ONLY the leading
YYYY-MM-DD so the zone offset can never shift the reported calendar day, returning epoch seconds at
UTC midnight (validated to reject impossible parts).

**Dates as ARGS:** `distributions` takes `start_date`/`end_date` (real SQL `DATE`; client-side
filter on the record date; named `*_date` because `END` is reserved). The vgi runtime hands a DATE
arg to `p.args` as epoch MILLISECONDS; `dateArgToEpoch` (vanguard.ts) converts it and is
magnitude-robust (epoch-ms, JS Date, bigint, days-since-epoch, or a YYYY-MM-DD string). Omitted/null
= unbounded. `nav_history` takes a `period` STRING arg (not dates — the API is period-windowed);
`argConstraints: { period: { choices: [...] } }` declares the closed set (VGI317) so agents
discover valid windows and a bad value fails bind. `normalizePeriod` still upper-cases/defaults.

## Fund identifier (`fund` arg)

`resolveFund(get, fund)`: Vanguard's per-fund endpoints are keyed by ticker, so this validates the
ticker against the (cached) catalog (case-insensitive) and returns the canonical upper-cased
ticker, or `null` (not a throw — vanguard.ts is SDK-free). `functions.ts` `resolveOrThrow` converts
null into an `ArgumentValidationError` with a "list tickers via products" hint. Every fund-scoped
call does one cached catalog fetch to resolve; the holdings scan resolves in bulk in `onInit`.

## Commands

```bash
bun install
bun test            # unit tests: SDK-free driver + Arrow batch builders + live HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` sets `VGI_TEST_WORKER=bin/vgi-etf-vanguard-worker` + `VGI_WORKER_CATALOG_NAME=vanguard`
and runs `test/sql/*.test`. The `.test` files are DESCRIBE-based schema asserts (bind-only → no
network → deterministic) plus a few live-invariant asserts that hit Vanguard (fine for an egress
connector). CI runs this, the reusable `ts-ci.yml`, and a `vgi-lint` gate at `--fail-on info`
(currently 100/100).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline) —
`bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Pin
`typescript ^6.0.3` (5.x descends into SDK `.ts` source and reports external errors).

## Gotchas / conventions

- Emit `bigint` (not `number`) for `Int64` columns via `batchFromColumns`; date fields go through
  `isoDate()` (→ epoch seconds) then the schema's `dateOrNull`.
- `noUncheckedIndexedAccess` is on: read parallel/array cells carefully (destructured elements type
  as possibly `undefined` and fail the typecheck).
- vgi-lint rules that must stay satisfied: catalog/schema descriptions must NOT enumerate the
  worker's own functions (VGI173 — describe purpose/concepts instead); argument docs must NOT
  restate the data type (VGI313 — the range docs say "record-day range", never "record-date" which
  the linter reads as the DATE type); numeric column comments should state a unit/definition
  (VGI131); an argument that enumerates allowed values needs `argConstraints.choices` (VGI317);
  every function needs an agent test task (VGI520 — all are covered in `catalog.ts`
  `vgi.agent_test_tasks`).
- Don't add a secret type; this worker is keyless by design.
- Don't add time travel to `holdings` — Vanguard has no historical as-of. This is the deliberate
  structural difference from vgi-etf-ishares.

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'vanguard' AS vanguard (TYPE vgi, LOCATION '/path/to/vgi-etf-vanguard/bin/vgi-etf-vanguard-worker');
SELECT ticker, long_name, expense_ratio_percent FROM vanguard.products ORDER BY expense_ratio_percent LIMIT 10;
SELECT ticker, name, weight_percent FROM vanguard.holdings WHERE fund_ticker = 'VOO' ORDER BY weight_percent DESC LIMIT 10;
SELECT as_of_date, nav FROM vanguard.nav_history('VOO', period := '1Y') ORDER BY as_of_date DESC;
```

// The VGI table functions and base-table backing scans: the `products` and `holdings` tables
// (backing scans) plus three callable functions — fund_details, distributions, nav_history. All
// keyless, all single-shot snapshots — function state is just a `done` flag (fully serializable;
// no socket / batch / Date), so the HTTP transport can round-trip it. The Vanguard `get` client is
// injected so worker.ts wires the real fetch and tests wire a fake.
//
// NOTE — Vanguard holdings are CURRENT-only: the holdings scan is hive-partitioned by fund_ticker
// but declares NO time travel (each fund reports one as-of date; `as_of_date` is an output column).

import {
  defineTableFunction,
  ArgumentValidationError,
  batchFromColumns,
  serializeBatch,
  deserializeFilters,
  buildJoinKeysLookup,
  DEFAULT_MAX_WORKERS,
  type OutputCollector,
} from "@query-farm/vgi";
import { Schema, Field, Utf8, DateDay } from "@query-farm/apache-arrow";
import {
  fetchProducts,
  fetchHoldings,
  fetchFundDetails,
  fetchDistributions,
  fetchNavHistory,
  resolveFund,
  dateArgToEpoch,
  normalizePeriod,
  NAV_PERIODS,
} from "./vanguard.js";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  fundDetailsSchema,
  fundDetailsBatch,
  distributionsSchema,
  distributionsBatch,
  navHistorySchema,
  navHistoryBatch,
  resultColumnsSchema,
} from "./schema.js";

/** The injected HTTP getter: URL in, parsed JSON out. */
export type VanguardGet = (url: string) => Promise<unknown>;

// Per-column descriptions for the `vgi.result_columns_schema` tag (JSON [{name,type,description}],
// generated from each Arrow schema via resultColumnsSchema).

const HOLDINGS_SCAN_DESCS: Record<string, string> = {
  fund_ticker: "The fund's ticker — the partition filter (e.g. VOO).",
  holding_rank: "1-based position within the fund, ordered by descending weight (largest holding = 1). With fund_ticker, the row's primary key.",
  as_of_date: "The as-of date Vanguard reports for these holdings.",
  name: "Constituent / issue name.",
  ticker: "Constituent ticker (the holding's own ticker; distinct from fund_ticker).",
  isin: "Constituent ISIN.",
  cusip: "Constituent CUSIP.",
  sedol: "Constituent SEDOL.",
  weight_percent: "Percent of the fund, 0–100 (7.89 = 7.89%).",
  market_value: "Market value held, in USD.",
  shares_held: "Quantity held, as a count of shares or units.",
  notional_value: "Notional value held, in USD.",
  sec_type: "Security type classification, when Vanguard supplies it.",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  maturity: "Maturity (fixed income only; may be an aggregated range).",
  face_amount: "Face/par amount held (fixed income only).",
};

const FUND_DETAILS_DESCS: Record<string, string> = {
  ticker: "Exchange ticker.",
  fund_id: "Vanguard internal fund id.",
  cusip: "Fund CUSIP.",
  long_name: "Full fund name.",
  short_name: "Abbreviated fund name.",
  asset_class: "Asset class (Equity, Fixed Income, …).",
  category: "Morningstar-style category.",
  management_style: "Index or Active.",
  inception_date: "Fund inception date.",
  expense_ratio_percent: "Expense ratio, percent points (0.03 = 0.03%).",
  price: "Latest NAV/closing price.",
  price_as_of: "As-of date for price.",
  market_price: "Latest market price.",
  premium_discount_percent: "Market price vs NAV, percent points.",
  yield_percent: "SEC/30-day yield, percent points.",
  yield_as_of: "As-of date for yield.",
  high_52w_price: "52-week high price.",
  low_52w_price: "52-week low price.",
  ytd_return_percent: "Year-to-date NAV return, percent points.",
  return_1y_percent: "1-year NAV return, percent points.",
  return_3y_percent: "Annualized 3-year NAV return, percent points.",
  return_5y_percent: "Annualized 5-year NAV return, percent points.",
  return_10y_percent: "Annualized 10-year NAV return, percent points.",
  return_since_inception_percent: "Annualized since-inception NAV return, percent points.",
  primary_benchmark: "Primary benchmark name.",
  benchmark_return_1y_percent: "Benchmark 1-year return, percent points.",
  beta: "Beta vs the primary benchmark (ratio, not a percent).",
  r_squared: "R-squared vs the primary benchmark (ratio, not a percent).",
  risk_level: "Vanguard's risk classification (e.g. Moderate to Aggressive).",
};

const DISTRIBUTIONS_DESCS: Record<string, string> = {
  record_date: "Record date.",
  reinvestment_date: "Reinvestment date.",
  payable_date: "Payable date.",
  distribution_type: "Distribution type (e.g. Dividend, Capital Gain).",
  per_share_amount: "Per-share distribution amount, in USD.",
  reinvest_price: "Reinvestment price per share.",
};

const NAV_HISTORY_DESCS: Record<string, string> = {
  as_of_date: "Valuation date.",
  nav: "Net asset value per share.",
  market_price: "Market (exchange) closing price that day.",
};

interface DoneState {
  done: boolean;
}

/** Guard a required string argument; returns the trimmed value or throws ArgumentValidationError. */
function required(fn: string, name: string, v: unknown): string {
  if (v == null || String(v).trim() === "") {
    throw new ArgumentValidationError(`${fn}: ${name} is required`);
  }
  return String(v).trim();
}

/** Resolve a `fund` arg to a canonical ticker, raising a typed, discoverable error when it misses. */
async function resolveOrThrow(fn: string, get: VanguardGet, fund: string): Promise<string> {
  const ticker = await resolveFund(get, fund);
  if (ticker == null) {
    throw new ArgumentValidationError(
      `${fn}: could not resolve fund '${fund}'. Pass a Vanguard ETF ticker (e.g. 'VOO'); ` +
        `list valid tickers with SELECT ticker FROM vanguard.main.products.`,
    );
  }
  return ticker;
}

// ── holdings queue plumbing (BoundStorage work queue + hive partition metadata) ──
//
// The holdings scan streams one fund per partition. `onInit` seeds a BoundStorage queue with the
// target funds (one item each); each `process()` tick pops a fund, fetches its holdings, and emits
// one SINGLE_VALUE partition. Multiple parallel workers drain the same execution-scoped queue, so
// the fan-out is naturally work-stealing and bounded by maxWorkers.

/** A queued fund: its ticker (the partition value) and whether it is a bond fund (endpoint pick). */
interface FundItem {
  ticker: string;
  isBond: boolean;
}
const encodeFund = (item: FundItem): Uint8Array => new TextEncoder().encode(JSON.stringify(item));
const decodeFund = (bytes: Uint8Array): FundItem => JSON.parse(new TextDecoder().decode(bytes));

/** Plain (non-annotated) field used to build the partition-values (min,max) batch. */
const FUND_TICKER_FIELD = new Field("fund_ticker", new Utf8(), true);

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Build the `vgi_partition_values#b64` batch metadata for a SINGLE_VALUE partition: a 2-row
 * (min,max) Arrow batch over fund_ticker where min == max == the fund's ticker.
 */
function partitionValues(ticker: string): Map<string, string> {
  const batch = batchFromColumns({ fund_ticker: [ticker, ticker] }, new Schema([FUND_TICKER_FIELD]));
  return new Map([["vgi_partition_values#b64", b64encode(serializeBatch(batch))]]);
}

// ── products (backing scan for the products TABLE) ──────────────────────────────
//
// `products` is exposed as a real base TABLE (see catalog.ts `tables`), not a table function, so
// users query `FROM vanguard.products` (no parens) and filter with WHERE — no arguments. This
// zero-arg scan is registered only for scan dispatch (it is NOT listed among the catalog's
// callable functions). It returns the Vanguard ETF catalog; a WHERE on ticker / asset_class
// narrows it.

export function makeProductsScan(get: VanguardGet) {
  const schema = productsSchema();
  return defineTableFunction<Record<string, never>, DoneState>({
    name: "products",
    description: "Vanguard US ETF catalog — backing scan for the products table.",
    args: {},
    onBind: () => ({ outputSchema: schema }),
    initialState: () => ({ done: false }),
    process: async (_p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchProducts(get);
      out.emit(productsBatch(schema, rows));
      state.done = true;
    },
  });
}

// ── holdings (backing scan for the holdings TABLE) ─────────────────────────────
//
// `holdings` is exposed as a base TABLE (see catalog.ts), HIVE-PARTITIONED on `fund_ticker` (the
// fund's ticker — distinct from the constituent `ticker` column). Vanguard holdings are
// CURRENT-only, so there is NO time travel:
//   SELECT * FROM vanguard.main.holdings WHERE fund_ticker = 'VOO';
//   SELECT * FROM vanguard.main.holdings WHERE fund_ticker IN ('VOO','BND');   -- fan-out per partition
//   SELECT * FROM vanguard.main.holdings;                                      -- ALL funds (every partition)
//
// Each fund is one SINGLE_VALUE partition. The scan is a streaming, queue-backed generator:
//   • onInit (runs once on the coordinator) reads the pushed fund_ticker filter — or, absent one,
//     the ENTIRE ETF catalog — resolves each to a fund item and pushes one per fund onto a
//     BoundStorage work queue keyed by the execution id.
//   • process() pops one fund per tick, fetches its current holdings, and emits a single
//     partition batch (tagged with vgi_partition_values so DuckDB sees fund_ticker as the key).
// Multiple parallel workers drain the same queue, so the all-funds fan-out is work-stealing and
// bounded by maxWorkers. filterPushdown + being LISTED is what lets DuckDB push fund_ticker here.

interface HoldingsScanArgs {
  fund_ticker: string | null;
}

const HOLDINGS_SCAN_FUND_DOC =
  "Optional single fund to scan, given as its exchange ticker like 'VOO'. Convenience shorthand " +
  "for the pushdown filter: holdings_scan(fund_ticker := 'VOO') is equivalent to the holdings table filtered to " +
  "that fund. Omit it (holdings_scan()) to scan every fund, optionally narrowing with a " +
  "WHERE fund_ticker = … clause instead. Case-insensitive; upper-cased internally.";

export function makeHoldingsScan(get: VanguardGet) {
  const schema = holdingsSchema();
  return defineTableFunction<HoldingsScanArgs, Record<string, never>>({
    name: "holdings_scan",
    description:
      "Backing scan for the holdings table — prefer the `holdings` table. Detailed current fund " +
      "holdings, hive-partitioned by fund_ticker: pass a single fund as holdings_scan(fund_ticker := 'VOO'), or " +
      "filter WHERE fund_ticker = 'VOO' (or fund_ticker IN (…)) for specific funds, or scan with " +
      "no filter to stream every fund's holdings. weight_percent is in percent points; bond funds " +
      "also fill coupon/maturity/face.",
    // Optional convenience arg: pick one fund directly. The `holdings` base table binds this scan
    // with zero args (fund_ticker → null), relying on pushdown; a direct holdings_scan(fund_ticker := 'VOO') call
    // supplies the fund up front. onInit unions the arg with any pushed fund_ticker filter.
    args: { fund_ticker: new Utf8() },
    argDefaults: { fund_ticker: null },
    argDocs: { fund_ticker: HOLDINGS_SCAN_FUND_DOC },
    // filterPushdown MUST be declared AND this function MUST be listed in the catalog so the DuckDB
    // extension can discover the capability and push the fund_ticker filter into the scan. Each
    // fund is one SINGLE_VALUE partition (fund_ticker is the hive partition key).
    filterPushdown: true,
    partitionKind: "SINGLE_VALUE_PARTITIONS",
    maxWorkers: DEFAULT_MAX_WORKERS,
    onBind: () => ({ outputSchema: schema }),
    // Seed the work queue (once, on the coordinator): one item per target fund.
    onInit: async ({ args, initCall, executionId, storage }) => {
      // Pushed fund_ticker value(s) from WHERE (= or IN), if any, UNIONed with the optional
      // fund_ticker argument. Absent both → scan all funds.
      const joinKeys = buildJoinKeysLookup(initCall.join_keys);
      const filters = initCall.pushdown_filters
        ? deserializeFilters(initCall.pushdown_filters, joinKeys)
        : undefined;
      const argTicker =
        args.fund_ticker != null && String(args.fund_ticker).trim() !== ""
          ? [String(args.fund_ticker).trim().toUpperCase()]
          : [];
      const requested = [
        ...new Set([
          ...(filters?.getColumnValues("fund_ticker") ?? []).map((t) => String(t).toUpperCase()),
          ...argTicker,
        ]),
      ];
      // Build the fund set from the (cached) ETF catalog. One fetch either way.
      const products = await fetchProducts(get);
      const byTicker = new Map(
        products
          .filter((r) => r.ticker)
          .map((r) => [
            String(r.ticker).toUpperCase(),
            { ticker: String(r.ticker).toUpperCase(), isBond: r.isBond },
          ]),
      );
      const targets: FundItem[] =
        requested.length > 0
          ? requested.map((t) => byTicker.get(t)).filter((x): x is FundItem => x != null)
          : [...byTicker.values()];
      await storage.queuePush(targets.map(encodeFund));
      return { max_workers: DEFAULT_MAX_WORKERS, execution_id: executionId, opaque_data: null };
    },
    initialState: () => ({}),
    process: async (p, _state, out: OutputCollector) => {
      // Pop one fund per tick; emit exactly one partition. Skip empty partitions and pop the next.
      // Queue empty → end of scan.
      for (;;) {
        const item = await p.storage!.queuePop();
        if (item === null) {
          out.finish();
          return;
        }
        const fund = decodeFund(item);
        const rows = await fetchHoldings(get, fund.ticker, fund.isBond);
        if (rows.length === 0) continue;
        out.emit(holdingsBatch(schema, rows), partitionValues(fund.ticker));
        return;
      }
    },
    examples: [
      { sql: "SELECT ticker, name, weight_percent FROM vanguard.main.holdings_scan(fund_ticker := 'VOO') ORDER BY weight_percent DESC LIMIT 10", description: "Top 10 holdings of VOO via the backing scan (fund passed as an argument)" },
      { sql: "SELECT fund_ticker, count(*) FROM vanguard.main.holdings_scan() WHERE fund_ticker IN ('VOO', 'BND') GROUP BY fund_ticker", description: "Two partitions at once via a pushdown filter (fan-out)" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The backing scan for the `holdings` table. Prefer querying the `holdings` table. Takes an " +
        "optional single fund_ticker argument: holdings_scan(fund_ticker := 'VOO') scans just that fund. " +
        "Hive-partitioned by fund_ticker (the fund's ticker, distinct from the constituent " +
        "`ticker` column): pass the fund as the argument, or filter WHERE fund_ticker = '…' (or " +
        "fund_ticker IN (…)) for specific funds, or scan with no argument/filter to stream every " +
        "fund (over a hundred partitions — slow). Holdings are current-only (no historical " +
        "as-of). weight_percent is in percent points (7.89 = 7.89%); bond funds also fill " +
        "coupon/maturity/face.",
      "vgi.doc_md":
        "## holdings_scan\n\n" +
        "The backing scan for the **`holdings` table** — prefer the table. Takes an optional " +
        "`fund_ticker` argument: `holdings_scan(fund_ticker := 'VOO')` scans one fund. Hive-partitioned by " +
        "`fund_ticker`: pass the fund as the argument, filter `WHERE fund_ticker = 'VOO'`, or scan " +
        "with no argument to stream every fund (see the example queries). `fund_ticker` is " +
        "distinct from the constituent `ticker` column. Holdings are current-only (no historical " +
        "as-of).",
      // Carry the same examples through the description-preserving example_queries tag: the VGI
      // extension re-surfaces Meta.examples into duckdb_functions().examples as a bare SQL VARCHAR[]
      // (descriptions dropped), so without this the descriptions are invisible to vgi-lint (VGI515).
      // Byte-identical SQL to the `examples:` above; the linter dedups by normalized SQL.
      "vgi.example_queries": JSON.stringify([
        { description: "Top 10 holdings of VOO via the backing scan (fund passed as an argument)", sql: "SELECT ticker, name, weight_percent FROM vanguard.main.holdings_scan(fund_ticker := 'VOO') ORDER BY weight_percent DESC LIMIT 10" },
        { description: "Two partitions at once via a pushdown filter (fan-out)", sql: "SELECT fund_ticker, count(*) FROM vanguard.main.holdings_scan() WHERE fund_ticker IN ('VOO', 'BND') GROUP BY fund_ticker" },
      ]),
      "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_SCAN_DESCS),
    },
  });
}

// ── fund_details ──────────────────────────────────────────────────────────────

interface FundArgs {
  fund: string;
}

const FUND_ARG_DOC =
  "The fund to look up, given as an exchange " +
  "ticker like 'VOO'. Required, first positional argument.";

export function makeFundDetailsFunction(get: VanguardGet) {
  const schema = fundDetailsSchema();
  return defineTableFunction<FundArgs, DoneState>({
    name: "fund_details",
    description:
      "A wide one-row snapshot of a single fund's key facts and characteristics: identifiers, " +
      "expense ratio, latest price and NAV, premium/discount, yield, 52-week band, annualized " +
      "returns, primary benchmark and its return, and beta / R-squared / risk level. `fund` is a " +
      "ticker like VOO.",
    args: { fund: new Utf8() },
    argDocs: { fund: FUND_ARG_DOC },
    onBind: (p) => {
      required("fund_details", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const ticker = await resolveOrThrow("fund_details", get, String(p.args.fund));
      const row = await fetchFundDetails(get, ticker);
      out.emit(fundDetailsBatch(schema, [row]));
      state.done = true;
    },
    examples: [
      { sql: "SELECT ticker, primary_benchmark, beta, expense_ratio_percent FROM vanguard.main.fund_details('VOO')", description: "Key characteristics for VOO" },
      { sql: "SELECT ticker, premium_discount_percent, high_52w_price, low_52w_price FROM vanguard.main.fund_details('VOO')", description: "Trading quality: premium/discount and 52-week band" },
      { sql: "SELECT return_1y_percent, benchmark_return_1y_percent FROM vanguard.main.fund_details('VOO')", description: "1-year fund return vs its benchmark" },
    ],
    tags: {
      "vgi.category": "catalog",
      "vgi.doc_llm":
        "One-row detail snapshot for a fund: identifiers, expense ratio, latest price/NAV, " +
        "premium/discount, yield, 52-week high/low, annualized returns (YTD/1y/3y/5y/10y/since " +
        "inception), the primary benchmark and its 1-year return, and beta / R-squared / risk " +
        "level. Percent columns are in percent points; beta and r_squared are ratios (not " +
        "percents). Deeper than the products row for a single fund.",
      "vgi.doc_md":
        "## fund_details\n\n" +
        "A wide one-row snapshot of a fund's key facts and characteristics — the details beyond what " +
        "`products` carries (premium/discount, 52-week band, benchmark comparison, beta/R²). Percent " +
        "columns are in percent points; `beta` and `r_squared` are ratios.\n\n" +
        "It returns exactly one row; for the whole lineup use `products` (see the example queries).",
      // Byte-identical SQL to the `examples:` above; carried here so the descriptions survive (the
      // native duckdb_functions().examples carrier drops them) — VGI515.
      "vgi.example_queries": JSON.stringify([
        { description: "Key characteristics for VOO", sql: "SELECT ticker, primary_benchmark, beta, expense_ratio_percent FROM vanguard.main.fund_details('VOO')" },
        { description: "Trading quality: premium/discount and 52-week band", sql: "SELECT ticker, premium_discount_percent, high_52w_price, low_52w_price FROM vanguard.main.fund_details('VOO')" },
        { description: "1-year fund return vs its benchmark", sql: "SELECT return_1y_percent, benchmark_return_1y_percent FROM vanguard.main.fund_details('VOO')" },
      ]),
      "vgi.result_columns_schema": resultColumnsSchema(fundDetailsSchema(), FUND_DETAILS_DESCS),
    },
  });
}

// ── distributions ─────────────────────────────────────────────────────────────

interface DistributionArgs {
  fund: string;
  start_date: Date | null;
  end_date: Date | null;
}

const RANGE_DOCS = {
  start_date:
    "Optional inclusive lower bound on the record-day range — omit for no lower bound. Filters " +
    "client-side.",
  end_date:
    "Optional inclusive upper bound on the record-day range — omit for no upper bound. Named " +
    "end_date because END is a reserved SQL keyword.",
};

export function makeDistributionsFunction(get: VanguardGet) {
  const schema = distributionsSchema();
  return defineTableFunction<DistributionArgs, DoneState>({
    name: "distributions",
    description:
      "Recent distribution history for a fund — one row per distribution with record, " +
      "reinvestment, and payable dates, the distribution type, the per-share amount, and the " +
      "reinvestment price. `fund` is a ticker; bound the record-date range with " +
      "start_date/end_date.",
    args: { fund: new Utf8(), start_date: new DateDay(), end_date: new DateDay() },
    argDefaults: { start_date: null, end_date: null },
    argDocs: { fund: FUND_ARG_DOC, ...RANGE_DOCS },
    onBind: (p) => {
      required("distributions", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const ticker = await resolveOrThrow("distributions", get, String(p.args.fund));
      const rows = await fetchDistributions(
        get,
        ticker,
        dateArgToEpoch(p.args.start_date),
        dateArgToEpoch(p.args.end_date),
      );
      out.emit(distributionsBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT record_date, per_share_amount FROM vanguard.main.distributions('VOO') ORDER BY record_date DESC LIMIT 8", description: "Recent VOO distributions" },
      { sql: "SELECT sum(per_share_amount) AS total FROM vanguard.main.distributions('VOO', start_date := DATE '2025-01-01')", description: "Total distributions since a start date" },
      { sql: "SELECT record_date, per_share_amount FROM vanguard.main.distributions('VOO', start_date := DATE '2024-01-01', end_date := DATE '2024-12-31') ORDER BY record_date", description: "Distributions within a bounded record-date window" },
    ],
    tags: {
      "vgi.category": "history",
      "vgi.doc_llm":
        "Distribution (dividend / capital-gain) history for a fund: record / reinvestment / " +
        "payable dates, the distribution type, the per-share amount, and the reinvestment price. " +
        "Amounts are per-share dollars, not percents. Bound the record-date range with " +
        "start_date/end_date. Vanguard publishes recent history (typically the last few years).",
      "vgi.doc_md":
        "## distributions\n\n" +
        "Recent distribution history, one row per distribution. Amounts are **per-share** dollars " +
        "(not percentages). Bound the record-date range with `start_date`/`end_date` (see the " +
        "example queries).",
      // Byte-identical SQL to the `examples:` above; carried here so the descriptions survive (the
      // native duckdb_functions().examples carrier drops them) — VGI515.
      "vgi.example_queries": JSON.stringify([
        { description: "Recent VOO distributions", sql: "SELECT record_date, per_share_amount FROM vanguard.main.distributions('VOO') ORDER BY record_date DESC LIMIT 8" },
        { description: "Total distributions since a start date", sql: "SELECT sum(per_share_amount) AS total FROM vanguard.main.distributions('VOO', start_date := DATE '2025-01-01')" },
        { description: "Distributions within a bounded record-date window", sql: "SELECT record_date, per_share_amount FROM vanguard.main.distributions('VOO', start_date := DATE '2024-01-01', end_date := DATE '2024-12-31') ORDER BY record_date" },
      ]),
      "vgi.result_columns_schema": resultColumnsSchema(distributionsSchema(), DISTRIBUTIONS_DESCS),
    },
  });
}

// ── nav_history ─────────────────────────────────────────────────────────────

interface NavHistoryArgs {
  fund: string;
  period: string;
}

const PERIOD_DOC =
  `The look-back window for the price series, one of ${NAV_PERIODS.join(", ")}. Defaults to 1Y. ` +
  "Shorter windows are daily; longer windows thin to weekly (5Y) or monthly (10Y).";

export function makeNavHistoryFunction(get: VanguardGet) {
  const schema = navHistorySchema();
  return defineTableFunction<NavHistoryArgs, DoneState>({
    name: "nav_history",
    description:
      "Net-asset-value and market-price history for a fund over a look-back window — one row per " +
      "observation with the NAV and the market (exchange) price. `fund` is a ticker; `period` " +
      "picks the window (1M/1Y/5Y/10Y, default 1Y). Longer windows return coarser (weekly/monthly) " +
      "points.",
    args: { fund: new Utf8(), period: new Utf8() },
    argDefaults: { period: "1Y" },
    argDocs: { fund: FUND_ARG_DOC, period: PERIOD_DOC },
    // Declare the closed choice set so agents discover valid windows via vgi_function_arguments()
    // (and a bad value fails bind rather than silently defaulting). Values are upper-case.
    argConstraints: { period: { choices: [...NAV_PERIODS], default: "1Y" } },
    onBind: (p) => {
      required("nav_history", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const ticker = await resolveOrThrow("nav_history", get, String(p.args.fund));
      const rows = await fetchNavHistory(get, ticker, normalizePeriod(p.args.period));
      out.emit(navHistoryBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT as_of_date, nav FROM vanguard.main.nav_history('VOO', period := '1Y') ORDER BY as_of_date DESC", description: "Daily VOO NAV over the past year" },
      { sql: "SELECT as_of_date, nav, market_price FROM vanguard.main.nav_history('VOO', period := '10Y') ORDER BY as_of_date", description: "10-year NAV vs market-price series (monthly points)" },
    ],
    tags: {
      "vgi.category": "history",
      "vgi.doc_llm":
        "NAV and market-price time series for a fund over a look-back window (period = 1M/1Y/5Y/" +
        "10Y, default 1Y). Each row carries the NAV and the market (exchange) price for a date. " +
        "Use it for NAV-based return series and NAV-vs-price comparison. Shorter windows are daily; " +
        "5Y thins to weekly and 10Y to monthly. This is fund NAV, not intraday candles.",
      "vgi.doc_md":
        "## nav_history\n\n" +
        "NAV and market-price history over a look-back window. Pick the window with `period` " +
        "(`1M`/`1Y`/`5Y`/`10Y`, default `1Y`); longer windows return coarser points (5Y weekly, " +
        "10Y monthly). This is **fund NAV**, not an intraday candle series (see the example queries).",
      // Byte-identical SQL to the `examples:` above; carried here so the descriptions survive (the
      // native duckdb_functions().examples carrier drops them) — VGI515.
      "vgi.example_queries": JSON.stringify([
        { description: "Daily VOO NAV over the past year", sql: "SELECT as_of_date, nav FROM vanguard.main.nav_history('VOO', period := '1Y') ORDER BY as_of_date DESC" },
        { description: "10-year NAV vs market-price series (monthly points)", sql: "SELECT as_of_date, nav, market_price FROM vanguard.main.nav_history('VOO', period := '10Y') ORDER BY as_of_date" },
      ]),
      "vgi.result_columns_schema": resultColumnsSchema(navHistorySchema(), NAV_HISTORY_DESCS),
    },
  });
}

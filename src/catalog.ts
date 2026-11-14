// The `vanguard` catalog descriptor + its metadata tags (the vgi.* discovery/doc channels
// vgi-lint grades). Vanguard's public product/holdings endpoints are KEYLESS, so there is NO
// secret type here.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is catalog-qualified
// (vanguard.main.<fn>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { Arguments, constraintRecord } from "@query-farm/vgi";
import { productsSchema, holdingsSchema, resultColumnsSchema } from "./schema.js";
import {
  BND_TRAILING_YIELD,
  NVDA_ACROSS_FUNDS,
  VOO_TOTAL_RETURN,
  VOO_VUG_OVERLAP,
  exampleQueriesTag,
} from "./examples.js";

// vgi.v3 serves table constraints as canonical records that DuckDB takes as engine facts
// (ENFORCED / ALL_ROWS only), so every record must hold for every row the scan emits. The
// records also decide served nullability: a column is NOT NULL exactly when a NOT_NULL or
// PRIMARY KEY record names it.
const MAIN = ["main"];
function primaryKey(table: string, columns: string[]) {
  return constraintRecord({
    schemaPath: MAIN, table, id: `${table}.pk`, kind: "PRIMARY_KEY",
    columns: columns.map((c) => [c]), enforcement: "ENFORCED", validation: "ALL_ROWS",
  });
}
function notNull(table: string, column: string) {
  return constraintRecord({
    schemaPath: MAIN, table, id: `${table}.${column}.not_null`, kind: "NOT_NULL",
    columns: [[column]], enforcement: "ENFORCED", validation: "ALL_ROWS",
  });
}

const REPO = "https://github.com/Query-farm/vgi-etf-vanguard";
const ISSUES = `${REPO}/issues`;

/** Per-column comments for the products table (surface as Arrow field metadata). */
const PRODUCTS_COLUMN_COMMENTS: Record<string, string> = {
  ticker: "Exchange ticker (e.g. VOO).",
  fund_id: "Vanguard internal fund id.",
  cusip: "CUSIP identifier.",
  short_name: "Abbreviated fund name.",
  long_name: "Full fund name as marketed, e.g. 'Vanguard S&P 500 ETF'.",
  asset_class: "Asset class (Equity, Fixed Income, Balanced, Money Market).",
  category: "Morningstar-style category, e.g. 'Large Blend'.",
  style: "Customized investment style, e.g. 'Stock - Large-Cap Blend'.",
  management_style: "Index or Active.",
  inception_date: "Fund inception date.",
  expense_ratio_percent: "Expense ratio, percent points (0.03 = 0.03%).",
  price: "Latest NAV/closing price per share, in USD.",
  price_as_of: "As-of date for price.",
  market_price: "Latest market (exchange) price per share, in USD.",
  yield_percent: "SEC/30-day yield, percent points.",
  yield_as_of: "As-of date for yield.",
  ytd_return_percent: "Year-to-date NAV return, percent points.",
  return_1m_percent: "Previous-month NAV return, percent points.",
  return_3m_percent: "Trailing 3-month NAV return, percent points.",
  return_1y_percent: "1-year NAV return, percent points.",
  return_3y_percent: "Annualized 3-year NAV return, percent points.",
  return_5y_percent: "Annualized 5-year NAV return, percent points.",
  return_10y_percent: "Annualized 10-year NAV return, percent points.",
  return_since_inception_percent: "Annualized since-inception NAV return, percent points.",
  risk_level: "Vanguard's risk classification (e.g. Moderate to Aggressive).",
  risk_code: "Numeric risk code (1 = most conservative … 5 = most aggressive).",
  primary_benchmark: "Primary benchmark name the fund tracks/compares to.",
  product_page_url: "Path to the fund page on investor.vanguard.com.",
};

/** Table-level metadata for the products base table (the vgi.* doc/discovery channels). */
const PRODUCTS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "catalog",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "fund catalog",
    "product list",
    "expense ratio",
    "yield",
    "ticker",
    "returns",
  ]),
  "vgi.doc_llm":
    "The Vanguard ETF catalog as a plain table (query it directly, no arguments): one row per US " +
    "ETF with ticker, names, identifiers, classification, expense ratio, latest price and NAV, " +
    "yield, and annualized returns. Narrow it with a WHERE clause on ticker, asset_class, " +
    "management_style, and so on. Percent columns hold percent points (0.03 means 0.03%). Start " +
    "here to find a fund's ticker for the other functions.",
  "vgi.doc_md":
    "## products\n\n" +
    "The Vanguard US ETF catalog as a base table — one row per fund. It takes no arguments; query " +
    "it directly and filter with a WHERE clause (e.g. `WHERE asset_class = 'Equity' ORDER BY " +
    "expense_ratio_percent`; see the example queries). Percent columns (`*_percent`) are in " +
    "**percent points** (an expense ratio of 0.03 means 0.03%). The ticker column is the key for " +
    "the other functions.",
  "vgi.example_queries": JSON.stringify([
    { description: "Cheapest Vanguard ETFs by expense ratio", sql: "SELECT ticker, long_name, expense_ratio_percent FROM vanguard.main.products ORDER BY expense_ratio_percent LIMIT 10" },
    { description: "Bond ETFs with their 1-year return", sql: "SELECT ticker, long_name, return_1y_percent FROM vanguard.main.products WHERE asset_class = 'Fixed Income' ORDER BY return_1y_percent DESC" },
    { description: "Look up a single fund by ticker", sql: "SELECT ticker, long_name, expense_ratio_percent FROM vanguard.main.products WHERE ticker = 'VOO'" },
  ]),
  "vgi.result_columns_schema": resultColumnsSchema(productsSchema(), PRODUCTS_COLUMN_COMMENTS),
};

/** Per-column comments for the holdings table. */
const HOLDINGS_COLUMN_COMMENTS: Record<string, string> = {
  fund_ticker: "The fund's ticker (e.g. VOO) — the hive partition key; constant for every row of a fund. Filter on it to pick funds; omit to stream all.",
  holding_rank: "1-based position of this holding within the fund, ordered by descending weight as Vanguard reports it. With fund_ticker it uniquely identifies the row (the primary key); the largest holding is holding_rank = 1.",
  as_of_date: "The as-of date Vanguard reports for these holdings (current holdings only).",
  name: "Constituent / issue name.",
  ticker: "Constituent ticker (the holding's own ticker; distinct from fund_ticker).",
  isin: "Constituent ISIN.",
  cusip: "Constituent CUSIP.",
  sedol: "Constituent SEDOL.",
  weight_percent: "Percent of the fund, 0–100 (7.89 = 7.89%; weights sum to ~100).",
  market_value: "Market value held, in USD.",
  shares_held: "Quantity held, as a count of shares or units.",
  notional_value: "Notional value held, in USD, when Vanguard supplies it (currently not published; null).",
  sec_type: "Vanguard security type, MAIN.SUB (e.g. EQ.STOCK, FI.US_GOV, MM.CASH for short-term reserves, DE.IND for index futures).",
  coupon_percent: "Coupon rate, percent points (fixed income and cash/money-market positions only).",
  maturity: "Maturity date as Vanguard prints it, MM/DD/YYYY text (fixed income and cash/money-market positions only).",
  face_amount: "Face/par amount held (fixed income and cash/money-market positions only).",
};

/** Table-level metadata for the holdings base table (fund-partitioned, current-only). */
const HOLDINGS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "holdings",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "holdings",
    "constituents",
    "portfolio",
    "weights",
    "positions",
    "exposure",
  ]),
  "vgi.doc_llm":
    "Detailed current portfolio holdings for Vanguard ETFs as a hive-partitioned table. It is " +
    "partitioned by fund_ticker (the FUND's ticker, distinct from the constituent `ticker` " +
    "column): filter `WHERE fund_ticker = '…'` (or `fund_ticker IN (…)`) to pick funds, or scan " +
    "with no filter to stream EVERY fund's holdings (over a hundred funds — slow, so prefer a " +
    "filter). Holdings are current-only — Vanguard reports a single as-of date (the as_of_date " +
    "column), with no historical time travel. Rows come back weight-descending; weight_percent is " +
    "in percent points (7.89 = 7.89%); bond funds also fill coupon/maturity/face. Join on " +
    "fund_ticker to products.ticker for fund-level facts.",
  "vgi.doc_md":
    "## holdings\n\n" +
    "Detailed **current** fund holdings as a **hive-partitioned table**, partitioned by " +
    "`fund_ticker` (the fund's ticker). `fund_ticker` is distinct from `ticker` (the constituent's " +
    "own ticker). Filter `WHERE fund_ticker = 'VOO'` for one fund, or scan with no filter to stream " +
    "every fund (see the example queries).\n\n" +
    "`WHERE fund_ticker IN ('VOO','BND')` fans out per partition; an unfiltered scan streams every " +
    "fund (over a hundred partitions — slow). Holdings are **current-only** (Vanguard reports one " +
    "as-of date; no time travel). `weight_percent` is in percent points (7.89 = 7.89%).",
  "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_COLUMN_COMMENTS),
  "vgi.example_queries": exampleQueriesTag([
    { description: "Top 10 current holdings of VOO", sql: "SELECT ticker, name, weight_percent FROM vanguard.main.holdings WHERE fund_ticker = 'VOO' ORDER BY weight_percent DESC LIMIT 10" },
    NVDA_ACROSS_FUNDS,
    VOO_VUG_OVERLAP,
    { description: "Two funds at once (partition fan-out)", sql: "SELECT fund_ticker, ticker, weight_percent FROM vanguard.main.holdings WHERE fund_ticker IN ('VOO', 'VTI')" },
    { description: "A bond fund also fills coupon / maturity / face", sql: "SELECT name, coupon_percent, maturity, weight_percent FROM vanguard.main.holdings WHERE fund_ticker = 'BND' LIMIT 5" },
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Vanguard ETFs",
  "vgi.subtitle": "Screen the Vanguard US ETF lineup and query current fund holdings, distributions and daily NAV and price history.",
  "vgi.doc_llm":
    "Vanguard US ETF data as SQL tables and table functions. Reach for it to screen the ETF " +
    "lineup on key facts (expense ratio, yield, returns), to inspect what a fund currently holds, " +
    "and to pull per-fund history like distributions and NAV/price series. The central concept is " +
    "the fund, identified by its exchange ticker (e.g. VOO); start from the catalog to find that " +
    "key, then drill into a specific fund. Holdings are current-only (no historical as-of). Data " +
    "is Vanguard's public product feed: best-effort, for informational use.",
  "vgi.doc_md":
    "## Vanguard ETFs\n\n" +
    "Vanguard US ETF data, exposed as DuckDB tables and table functions.\n\n" +
    "The **fund** is the unit of the data and is keyed by an exchange `ticker` (e.g. `VOO`) — begin " +
    "at the catalog to discover that key, then drill into a fund. Fund holdings are " +
    "**current-only**: Vanguard reports a single as-of date per fund, so there is no historical " +
    "time travel (unlike some other providers).\n\n" +
    "Data is provided for informational use; review Vanguard's terms before redistribution.",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "Vanguard",
    "holdings",
    "portfolio",
    "fund",
    "NAV",
    "distributions",
    "dividends",
    "expense ratio",
    "index fund",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No expected_result —
  // Vanguard data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "cheapest_etfs",
      description: "The cheapest Vanguard ETFs by expense ratio",
      sql: "SELECT ticker, long_name, expense_ratio_percent FROM vanguard.main.products ORDER BY expense_ratio_percent LIMIT 5",
    },
    {
      name: "top_holdings",
      description: "The top holdings of the Vanguard S&P 500 ETF",
      sql: "SELECT ticker, name, weight_percent FROM vanguard.main.holdings WHERE fund_ticker = 'VOO' ORDER BY weight_percent DESC LIMIT 5",
    },
  ]),
  // Agent-suitability suite (catalog only). Only each task's name + prompt is published
  // here (VGI416); the grader fields live in the private sidecar vgi-agent-tests.yaml,
  // keyed by task name, and are never shown to the analyst.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "voo_exists",
      prompt: "Does Vanguard offer an ETF with the ticker VOO, and what is it called?",
    },
    {
      name: "voo_top_holding",
      prompt: "What is the single largest holding of the Vanguard S&P 500 ETF (VOO) right now?",
    },
    {
      name: "voo_holdings_scan",
      prompt: "Using the holdings backing scan, list a few VOO constituents by weight.",
    },
    {
      name: "voo_expense_ratio",
      prompt: "What is the expense ratio of the Vanguard S&P 500 ETF (VOO)?",
    },
    {
      name: "voo_benchmark",
      prompt: "Which benchmark does the Vanguard S&P 500 ETF (VOO) track, and what is its beta to it?",
    },
    {
      name: "voo_nav_history",
      prompt: "What has the Vanguard S&P 500 ETF's (VOO) NAV done over the past year?",
    },
    {
      name: "mega_cap_concentration",
      prompt:
        "Of Vanguard's three mega-cap ETFs — Mega Cap (MGC), Mega Cap Growth (MGK) and Mega Cap " +
        "Value (MGV) — which is the most concentrated, measured as the combined portfolio weight of " +
        "its ten largest holdings? Give that combined weight for each of the three funds, and the " +
        "full name and expense ratio of the most concentrated one.",
    },
    {
      name: "voo_last_distribution",
      prompt: "When did the Vanguard S&P 500 ETF (VOO) most recently pay a distribution, and how much?",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Vanguard Fund Data",
  "vgi.doc_llm":
    "Functions that return Vanguard ETF data at two levels. At the catalog level you screen the " +
    "whole lineup on key facts and resolve a fund's key. At the fund level you drill into one " +
    "fund — its current holdings, its characteristics, and its distribution and NAV/price history. " +
    "A fund is keyed by its exchange `ticker` (e.g. `VOO`); resolve the key at the catalog level " +
    "first. Holdings are current-only (no historical as-of).",
  "vgi.doc_md":
    "## Vanguard fund data\n\n" +
    "Work happens at two levels. **Catalog level:** screen the lineup on key facts and find a " +
    "fund's key. **Fund level:** drill into a single fund — its current constituents, " +
    "characteristics, and time series. A fund is keyed by its exchange `ticker` (e.g. `VOO`).\n\n" +
    "Holdings are current-only: Vanguard reports one as-of date per fund, with no historical " +
    "time travel.",
  "vgi.keywords": JSON.stringify(["ETF holdings", "fund catalog", "NAV history", "distributions", "portfolio"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    { name: "catalog", title: "Fund Catalog", description: "The ETF list and per-fund characteristics." },
    { name: "holdings", title: "Holdings", description: "Detailed current portfolio holdings." },
    { name: "history", title: "History", description: "Per-fund distribution and NAV/price time series." },
  ]),
  "vgi.example_queries": exampleQueriesTag([
    { description: "Cheapest Vanguard ETFs by expense ratio", sql: "SELECT ticker, long_name, expense_ratio_percent FROM vanguard.main.products ORDER BY expense_ratio_percent LIMIT 10" },
    { description: "Top holdings of VOO", sql: "SELECT ticker, name, weight_percent FROM vanguard.main.holdings WHERE fund_ticker = 'VOO' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Recent NAV history for VOO", sql: "SELECT as_of_date, nav FROM vanguard.main.nav_history('VOO', period := '1Y') ORDER BY as_of_date DESC" },
    // Composed: two of the worker's objects in one query.
    NVDA_ACROSS_FUNDS,
    VOO_VUG_OVERLAP,
    BND_TRAILING_YIELD,
    VOO_TOTAL_RETURN,
  ]),
};

/**
 * @param functions    the callable table functions (fund_details, distributions, nav_history) —
 *                      NOT products or holdings, which are base tables.
 * @param productsScan  the zero-arg scan backing the `products` base table.
 * @param holdingsScan  the pushdown scan backing the `holdings` base table.
 * Both scans are registered for scan dispatch but exposed to DuckDB only as tables.
 */
export function makeCatalog(
  functions: VgiFunction[],
  productsScan: VgiFunction,
  holdingsScan: VgiFunction,
): CatalogDescriptor {
  return {
    name: "vanguard",
    defaultSchema: "main",
    comment:
      "Vanguard US ETF data as DuckDB tables: products (catalog) & holdings (fund-partitioned, " +
      "current-only) tables, plus fund_details, distributions, nav_history — vgi-etf-vanguard",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "Vanguard fund data: ETF catalog, detailed current holdings, and per-fund history.",
        tags: SCHEMA_TAGS,
        functions: [...functions, holdingsScan],
        tables: [
          {
            name: "products",
            function: productsScan,
            arguments: new Arguments([], new Map()),
            // One row per exchange ticker: the products scan drops ticker-less entries and repeated
            // tickers, so ticker is a guaranteed key.
            constraints: [primaryKey("products", ["ticker"])],
            // The Vanguard US ETF lineup is ~116 funds; headroom to ~200.
            inlinedCardinality: { estimate: 116n, max: 200n },
            comment:
              "Every Vanguard US ETF with its key facts, one row per fund. Query directly (no " +
              "arguments) and filter with WHERE; percent columns are in percent points.",
            columnComments: PRODUCTS_COLUMN_COMMENTS,
            tags: PRODUCTS_TABLE_TAGS,
          },
          {
            name: "holdings",
            function: holdingsScan,
            arguments: new Arguments([], new Map()),
            // (fund_ticker, holding_rank) uniquely identifies a row: fund_ticker is the partition,
            // holding_rank is the 1-based per-fund position. Both are always populated by the scan.
            // Vanguard aggregates bond lots, so no natural constituent id (cusip/ticker) is unique
            // or always present — the ordinal surrogate gives each row a stable identity.
            constraints: [
              primaryKey("holdings", ["fund_ticker", "holding_rank"]),
              notNull("holdings", "fund_ticker"),
            ],
            // Hive partition key: fund_ticker. A WHERE fund_ticker = … / IN (…) filter is pushed
            // down to fetch just those funds; an unfiltered scan streams every fund (all
            // partitions). Vanguard holdings are current-only — NO time travel.
            // Whole-table estimate: ~116 funds; an equity fund is ~few hundred rows, a broad bond
            // fund can exceed 10,000 constituents.
            inlinedCardinality: { estimate: 100000n, max: 1500000n },
            comment:
              "Detailed current fund holdings, hive-partitioned by fund_ticker (filter WHERE " +
              "fund_ticker = … for one fund, or scan unfiltered for all). Current-only — no time " +
              "travel; as_of_date reflects Vanguard's reported date.",
            columnComments: HOLDINGS_COLUMN_COMMENTS,
            tags: HOLDINGS_TABLE_TAGS,
          },
        ],
      },
    ],
  };
}

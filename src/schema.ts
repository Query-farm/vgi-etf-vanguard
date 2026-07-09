// Arrow output schemas + row→batch mapping for the products/holdings tables and the three
// table functions.
//
// Vanguard data has a STABLE, known shape, so we emit real typed columns (not a single JSON
// string): Utf8 identifiers/names, Float64 prices/weights/returns, Int64 codes, and a real Arrow
// DATE (Date32) for every calendar date. `batchFromColumns` defaults to the "rich" representation,
// so a DATE cell is a JS `Date` (at UTC midnight) and an Int64 cell is a bigint. Percent-valued
// columns carry a `_percent` suffix and hold percent-magnitude numbers (e.g. 7.38 = 7.38%),
// matching Vanguard's raw values.

import { Schema, Field, Utf8, Float64, Int64, DateDay } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type {
  ProductRow,
  HoldingRow,
  FundDetailsRow,
  DistributionRow,
  NavHistoryRow,
} from "./vanguard.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const date = () => new DateDay();

/**
 * A hive-style partition-column field: carries `vgi.partition_column = "true"` so the DuckDB
 * binder treats it as a partition key. `holdings` is partitioned on `fund_ticker` — each scanned
 * fund is one SINGLE_VALUE partition (see makeHoldingsScan). Mirrors vgi's `partition_field`.
 */
const partitionField = (name: string, type: ConstructorParameters<typeof Field>[1]) =>
  new Field(name, type, true, new Map([["vgi.partition_column", "true"]]));

/** Map an Arrow field type to the DuckDB type name shown in docs. */
function duckdbType(type: unknown): string {
  const n = (type as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (n.startsWith("Utf8")) return "VARCHAR";
  if (n.startsWith("Float")) return "DOUBLE";
  if (n.startsWith("Int") || n.startsWith("Uint")) return "BIGINT";
  if (n.startsWith("Date")) return "DATE";
  return "VARCHAR";
}

/**
 * Build the `vgi.result_columns_schema` tag value (a JSON array of {name, type, description})
 * for a static result schema, DRY from the Arrow schema + a name→description map.
 */
export function resultColumnsSchema(schema: Schema, descriptions: Record<string, string>): string {
  return JSON.stringify(
    schema.fields.map((field) => ({
      name: field.name,
      type: duckdbType(field.type),
      description: descriptions[field.name] ?? field.name,
    })),
  );
}

/** bigint | null for an Int64 cell from a JS number that may be null. */
const bigOrNull = (v: number | null): bigint | null => (v == null ? null : BigInt(Math.trunc(v)));

/** JS Date | null for a DATE (Date32) cell from epoch SECONDS at UTC midnight. */
const dateOrNull = (sec: number | null): Date | null => (sec == null ? null : new Date(sec * 1000));

// ── products ──────────────────────────────────────────────────────────────────

export function productsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_id", new Utf8()),
    f("cusip", new Utf8()),
    f("short_name", new Utf8()),
    f("long_name", new Utf8()),
    f("asset_class", new Utf8()),
    f("category", new Utf8()),
    f("style", new Utf8()),
    f("management_style", new Utf8()),
    f("inception_date", date()),
    f("expense_ratio_percent", new Float64()),
    f("price", new Float64()),
    f("price_as_of", date()),
    f("market_price", new Float64()),
    f("yield_percent", new Float64()),
    f("yield_as_of", date()),
    f("ytd_return_percent", new Float64()),
    f("return_1m_percent", new Float64()),
    f("return_3m_percent", new Float64()),
    f("return_1y_percent", new Float64()),
    f("return_3y_percent", new Float64()),
    f("return_5y_percent", new Float64()),
    f("return_10y_percent", new Float64()),
    f("return_since_inception_percent", new Float64()),
    f("risk_level", new Utf8()),
    f("risk_code", new Int64()),
    f("primary_benchmark", new Utf8()),
    f("product_page_url", new Utf8()),
  ]);
}

export function productsBatch(schema: Schema, rows: ProductRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_id: rows.map((r) => r.fundId),
      cusip: rows.map((r) => r.cusip),
      short_name: rows.map((r) => r.shortName),
      long_name: rows.map((r) => r.longName),
      asset_class: rows.map((r) => r.assetClass),
      category: rows.map((r) => r.category),
      style: rows.map((r) => r.style),
      management_style: rows.map((r) => r.managementStyle),
      inception_date: rows.map((r) => dateOrNull(r.inceptionDate)),
      expense_ratio_percent: rows.map((r) => r.expenseRatioPercent),
      price: rows.map((r) => r.price),
      price_as_of: rows.map((r) => dateOrNull(r.priceAsOf)),
      market_price: rows.map((r) => r.marketPrice),
      yield_percent: rows.map((r) => r.yieldPercent),
      yield_as_of: rows.map((r) => dateOrNull(r.yieldAsOf)),
      ytd_return_percent: rows.map((r) => r.ytdReturnPercent),
      return_1m_percent: rows.map((r) => r.return1mPercent),
      return_3m_percent: rows.map((r) => r.return3mPercent),
      return_1y_percent: rows.map((r) => r.return1yPercent),
      return_3y_percent: rows.map((r) => r.return3yPercent),
      return_5y_percent: rows.map((r) => r.return5yPercent),
      return_10y_percent: rows.map((r) => r.return10yPercent),
      return_since_inception_percent: rows.map((r) => r.returnSinceInceptionPercent),
      risk_level: rows.map((r) => r.riskLevel),
      risk_code: rows.map((r) => bigOrNull(r.riskCode)),
      primary_benchmark: rows.map((r) => r.primaryBenchmark),
      product_page_url: rows.map((r) => r.productPageUrl),
    },
    schema,
  );
}

// ── holdings ────────────────────────────────────────────────────────────────

export function holdingsSchema(): Schema {
  return new Schema([
    // fund_ticker is the hive partition key: holdings_scan emits one SINGLE_VALUE partition per fund.
    partitionField("fund_ticker", new Utf8()),
    f("as_of_date", date()),
    f("name", new Utf8()),
    f("ticker", new Utf8()),
    f("isin", new Utf8()),
    f("cusip", new Utf8()),
    f("sedol", new Utf8()),
    f("weight_percent", new Float64()),
    f("market_value", new Float64()),
    f("shares_held", new Float64()),
    f("notional_value", new Float64()),
    f("sec_type", new Utf8()),
    f("coupon_percent", new Float64()),
    f("maturity", new Utf8()),
    f("face_amount", new Float64()),
  ]);
}

export function holdingsBatch(schema: Schema, rows: HoldingRow[]) {
  return batchFromColumns(
    {
      fund_ticker: rows.map((r) => r.fundTicker),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      name: rows.map((r) => r.name),
      ticker: rows.map((r) => r.ticker),
      isin: rows.map((r) => r.isin),
      cusip: rows.map((r) => r.cusip),
      sedol: rows.map((r) => r.sedol),
      weight_percent: rows.map((r) => r.weightPercent),
      market_value: rows.map((r) => r.marketValue),
      shares_held: rows.map((r) => r.sharesHeld),
      notional_value: rows.map((r) => r.notionalValue),
      sec_type: rows.map((r) => r.secType),
      coupon_percent: rows.map((r) => r.couponPercent),
      maturity: rows.map((r) => r.maturity),
      face_amount: rows.map((r) => r.faceAmount),
    },
    schema,
  );
}

// ── fund_details ──────────────────────────────────────────────────────────────

export function fundDetailsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_id", new Utf8()),
    f("cusip", new Utf8()),
    f("long_name", new Utf8()),
    f("short_name", new Utf8()),
    f("asset_class", new Utf8()),
    f("category", new Utf8()),
    f("management_style", new Utf8()),
    f("inception_date", date()),
    f("expense_ratio_percent", new Float64()),
    f("price", new Float64()),
    f("price_as_of", date()),
    f("market_price", new Float64()),
    f("premium_discount_percent", new Float64()),
    f("yield_percent", new Float64()),
    f("yield_as_of", date()),
    f("high_52w_price", new Float64()),
    f("low_52w_price", new Float64()),
    f("ytd_return_percent", new Float64()),
    f("return_1y_percent", new Float64()),
    f("return_3y_percent", new Float64()),
    f("return_5y_percent", new Float64()),
    f("return_10y_percent", new Float64()),
    f("return_since_inception_percent", new Float64()),
    f("primary_benchmark", new Utf8()),
    f("benchmark_return_1y_percent", new Float64()),
    f("beta", new Float64()),
    f("r_squared", new Float64()),
    f("risk_level", new Utf8()),
  ]);
}

export function fundDetailsBatch(schema: Schema, rows: FundDetailsRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_id: rows.map((r) => r.fundId),
      cusip: rows.map((r) => r.cusip),
      long_name: rows.map((r) => r.longName),
      short_name: rows.map((r) => r.shortName),
      asset_class: rows.map((r) => r.assetClass),
      category: rows.map((r) => r.category),
      management_style: rows.map((r) => r.managementStyle),
      inception_date: rows.map((r) => dateOrNull(r.inceptionDate)),
      expense_ratio_percent: rows.map((r) => r.expenseRatioPercent),
      price: rows.map((r) => r.price),
      price_as_of: rows.map((r) => dateOrNull(r.priceAsOf)),
      market_price: rows.map((r) => r.marketPrice),
      premium_discount_percent: rows.map((r) => r.premiumDiscountPercent),
      yield_percent: rows.map((r) => r.yieldPercent),
      yield_as_of: rows.map((r) => dateOrNull(r.yieldAsOf)),
      high_52w_price: rows.map((r) => r.high52wPrice),
      low_52w_price: rows.map((r) => r.low52wPrice),
      ytd_return_percent: rows.map((r) => r.ytdReturnPercent),
      return_1y_percent: rows.map((r) => r.return1yPercent),
      return_3y_percent: rows.map((r) => r.return3yPercent),
      return_5y_percent: rows.map((r) => r.return5yPercent),
      return_10y_percent: rows.map((r) => r.return10yPercent),
      return_since_inception_percent: rows.map((r) => r.returnSinceInceptionPercent),
      primary_benchmark: rows.map((r) => r.primaryBenchmark),
      benchmark_return_1y_percent: rows.map((r) => r.benchmarkReturn1yPercent),
      beta: rows.map((r) => r.beta),
      r_squared: rows.map((r) => r.rSquared),
      risk_level: rows.map((r) => r.riskLevel),
    },
    schema,
  );
}

// ── distributions ─────────────────────────────────────────────────────────────

export function distributionsSchema(): Schema {
  return new Schema([
    f("record_date", date()),
    f("reinvestment_date", date()),
    f("payable_date", date()),
    f("distribution_type", new Utf8()),
    f("per_share_amount", new Float64()),
    f("reinvest_price", new Float64()),
  ]);
}

export function distributionsBatch(schema: Schema, rows: DistributionRow[]) {
  return batchFromColumns(
    {
      record_date: rows.map((r) => dateOrNull(r.recordDate)),
      reinvestment_date: rows.map((r) => dateOrNull(r.reinvestmentDate)),
      payable_date: rows.map((r) => dateOrNull(r.payableDate)),
      distribution_type: rows.map((r) => r.distributionType),
      per_share_amount: rows.map((r) => r.perShareAmount),
      reinvest_price: rows.map((r) => r.reinvestPrice),
    },
    schema,
  );
}

// ── nav_history ───────────────────────────────────────────────────────────────

export function navHistorySchema(): Schema {
  return new Schema([
    f("as_of_date", date()),
    f("nav", new Float64()),
    f("market_price", new Float64()),
  ]);
}

export function navHistoryBatch(schema: Schema, rows: NavHistoryRow[]) {
  return batchFromColumns(
    {
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      nav: rows.map((r) => r.nav),
      market_price: rows.map((r) => r.marketPrice),
    },
    schema,
  );
}

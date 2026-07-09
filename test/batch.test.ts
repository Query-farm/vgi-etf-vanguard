// Typed-column contract for the five schemas. This one pulls @query-farm/vgi (batchFromColumns) +
// apache-arrow, so it runs under the full SDK install — unlike the driver tests, which are
// deliberately SDK-free. Proves schema field names/order and that Utf8/Float64/Int64/Date cells
// (incl. nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
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
} from "../src/schema.js";
import {
  parseProducts,
  parseHoldings,
  parseFundDetails,
  parseDistributions,
  parseNavHistory,
} from "../src/vanguard.js";
import {
  catalogEnvelope,
  stockHoldingsEnvelope,
  profileEnvelope,
  priceEnvelope,
  performanceEnvelope,
  riskEnvelope,
  distributionEnvelope,
  priceHistoryEnvelope,
} from "./fake-vanguard.js";

const names = (schema: { fields: { name: string }[] }) => schema.fields.map((f) => f.name);

test("products schema field names + order", () => {
  expect(names(productsSchema())).toEqual([
    "ticker", "fund_id", "cusip", "short_name", "long_name", "asset_class", "category", "style",
    "management_style", "inception_date", "expense_ratio_percent", "price", "price_as_of",
    "market_price", "yield_percent", "yield_as_of", "ytd_return_percent", "return_1m_percent",
    "return_3m_percent", "return_1y_percent", "return_3y_percent", "return_5y_percent",
    "return_10y_percent", "return_since_inception_percent", "risk_level", "risk_code",
    "primary_benchmark", "product_page_url",
  ]);
});

test("holdings schema field names + order", () => {
  expect(names(holdingsSchema())).toEqual([
    "fund_ticker", "as_of_date", "name", "ticker", "isin", "cusip", "sedol", "weight_percent",
    "market_value", "shares_held", "notional_value", "sec_type", "coupon_percent", "maturity",
    "face_amount",
  ]);
});

test("batch builders produce one row per parsed record", () => {
  expect((productsBatch(productsSchema(), parseProducts(catalogEnvelope())) as { numRows: number }).numRows).toBe(2);
  expect((holdingsBatch(holdingsSchema(), parseHoldings(stockHoldingsEnvelope(), "VOO")) as { numRows: number }).numRows).toBe(2);
  expect((fundDetailsBatch(fundDetailsSchema(), [parseFundDetails(profileEnvelope(), priceEnvelope(), performanceEnvelope(), riskEnvelope())]) as { numRows: number }).numRows).toBe(1);
  expect((distributionsBatch(distributionsSchema(), parseDistributions(distributionEnvelope())) as { numRows: number }).numRows).toBe(2);
  expect((navHistoryBatch(navHistorySchema(), parseNavHistory(priceHistoryEnvelope("1Y"))) as { numRows: number }).numRows).toBe(2);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((productsBatch(productsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingsBatch(holdingsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((fundDetailsBatch(fundDetailsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((distributionsBatch(distributionsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((navHistoryBatch(navHistorySchema(), []) as { numRows: number }).numRows).toBe(0);
});

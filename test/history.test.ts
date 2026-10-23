// Archetype proof for the per-fund detail/history drivers: fund_details and distributions
// (both from the whole-fund <T>.json), and nav_history (price-history). SDK-free.

import { test, expect } from "bun:test";
import {
  parseFundDetails,
  parseDistributions,
  parseNavHistory,
  normalizePeriod,
  fetchFundDetails,
  fetchDistributions,
  fetchNavHistory,
} from "../src/vanguard.js";
import {
  FakeVanguard,
  fundDataEnvelope,
  priceHistoryEnvelope,
} from "./fake-vanguard.js";

test("parseFundDetails flattens the whole-fund JSON into one row", () => {
  const row = parseFundDetails(fundDataEnvelope());
  expect(row.ticker).toBe("VOO");
  expect(row.fundId).toBe("0968");
  expect(row.cusip).toBe("922908363");
  expect(row.longName).toBe("Vanguard S&P 500 ETF");
  expect(row.shortName).toBe("S&P 500 ETF");
  expect(row.assetClass).toBe("Equity");
  expect(row.category).toBe("Large Blend");
  expect(row.managementStyle).toBe("Index");
  expect(row.expenseRatioPercent).toBe(0.03);
  expect(row.price).toBe(702.06);
  expect(row.priceAsOf).toBe(Math.floor(Date.UTC(2026, 9, 22) / 1000));
  expect(row.marketPrice).toBe(702.3);
  expect(row.premiumDiscountPercent).toBe(-0.15);
  expect(row.yieldPercent).toBe(1.0);
  expect(row.yieldAsOf).toBe(Math.floor(Date.UTC(2026, 8, 30) / 1000));
  expect(row.high52wPrice).toBe(716.11);
  expect(row.low52wPrice).toBe(580.89);
  expect(row.inceptionDate).toBe(Math.floor(Date.UTC(2010, 8, 7) / 1000));
  // month-end annualized returns
  expect(row.ytdReturnPercent).toBe(12.72);
  expect(row.return1yPercent).toBe(15.7);
  expect(row.return10yPercent).toBe(15.29);
  expect(row.benchmarkReturn1yPercent).toBe(15.74);
  // volatility + risk
  expect(row.primaryBenchmark).toBe("S&P 500 Index");
  expect(row.beta).toBe(1.0);
  expect(row.rSquared).toBe(1.0);
  expect(row.riskLevel).toBe("Moderate to Aggressive");
});

test("parseFundDetails degrades to nulls on an empty envelope", () => {
  for (const env of [{}, null, { performancefees: { historicalVolatilityMeasure: { volatilityMeasure: [] } } }]) {
    const row = parseFundDetails(env);
    expect(row.ticker).toBeNull();
    expect(row.price).toBeNull();
    expect(row.beta).toBeNull();
    expect(row.primaryBenchmark).toBeNull();
  }
});

test("parseDistributions maps items and parses the $-prefixed amount", () => {
  const rows = parseDistributions(fundDataEnvelope());
  expect(rows.length).toBe(2);
  const d0 = rows[0]!;
  expect(d0.distributionType).toBe("Dividend");
  expect(d0.perShareAmount).toBe(1.8226);
  expect(d0.recordDate).toBe(Math.floor(Date.UTC(2026, 8, 28) / 1000));
  expect(d0.reinvestmentDate).toBe(Math.floor(Date.UTC(2026, 8, 28) / 1000));
  expect(d0.payableDate).toBe(Math.floor(Date.UTC(2026, 8, 30) / 1000));
  expect(d0.reinvestPrice).toBe(703.53);
});

test("parseDistributions bounds rows by record date [start, end]", () => {
  const start = Math.floor(Date.UTC(2026, 6, 1) / 1000); // Jul 1 2026 → drops the Jun 26 row
  const rows = parseDistributions(fundDataEnvelope(), start, null);
  expect(rows.length).toBe(1);
  expect(rows[0]!.recordDate).toBe(Math.floor(Date.UTC(2026, 8, 28) / 1000));
  const end = Math.floor(Date.UTC(2026, 6, 1) / 1000);
  expect(parseDistributions(fundDataEnvelope(), null, end).map((r) => r.recordDate)).toEqual([
    Math.floor(Date.UTC(2026, 5, 26) / 1000),
  ]);
  expect(parseDistributions({})).toEqual([]);
});

test("normalizePeriod accepts the supported windows and defaults otherwise", () => {
  expect(normalizePeriod("1y")).toBe("1Y");
  expect(normalizePeriod("10Y")).toBe("10Y");
  expect(normalizePeriod(null)).toBe("1Y");
  expect(normalizePeriod("MAX")).toBe("1Y"); // unsupported → default
});

test("parseNavHistory zips nav + market price by date", () => {
  const rows = parseNavHistory(priceHistoryEnvelope("1Y"));
  expect(rows.length).toBe(2);
  const r0 = rows[0]!;
  expect(r0.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  expect(r0.nav).toBe(687.23);
  expect(r0.marketPrice).toBe(687.08);
});

test("parseNavHistory returns [] for an empty envelope, no throw", () => {
  expect(parseNavHistory({})).toEqual([]);
  expect(parseNavHistory({ nav: [] })).toEqual([]);
});

test("fetchFundDetails reads the whole-fund JSON once", async () => {
  const fake = FakeVanguard.router({ fundData: fundDataEnvelope() });
  const row = await fetchFundDetails(fake.get, "voo");
  expect(row.beta).toBe(1.0);
  expect(fake.calls).toEqual(["https://investor.vanguard.com/irr/funds/profile/VOO.json"]);
});

test("fetchDistributions reads the whole-fund JSON", async () => {
  const fake = FakeVanguard.router({ fundData: fundDataEnvelope() });
  const rows = await fetchDistributions(fake.get, "VOO");
  expect(rows.length).toBe(2);
  expect(fake.calls[0]).toBe("https://investor.vanguard.com/irr/funds/profile/VOO.json");
});

test("fetchNavHistory hits the price-history endpoint for the requested period", async () => {
  const fake = FakeVanguard.router({ priceHistory: (p) => priceHistoryEnvelope(p) });
  const rows = await fetchNavHistory(fake.get, "VOO", "10Y");
  expect(rows.length).toBe(2);
  expect(fake.calls[0]).toContain("/price-history/10Y");
});

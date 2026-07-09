// Archetype proof for the per-fund detail/history drivers: fund_details (profile + price +
// performance + risk), distributions, and nav_history (price-history). SDK-free.

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
  profileEnvelope,
  priceEnvelope,
  performanceEnvelope,
  riskEnvelope,
  distributionEnvelope,
  priceHistoryEnvelope,
} from "./fake-vanguard.js";

test("parseFundDetails merges profile + price + performance + risk into one row", () => {
  const row = parseFundDetails(profileEnvelope(), priceEnvelope(), performanceEnvelope(), riskEnvelope());
  expect(row.ticker).toBe("VOO");
  expect(row.fundId).toBe("0968");
  expect(row.longName).toBe("Vanguard S&P 500 ETF");
  expect(row.assetClass).toBe("Equity");
  expect(row.expenseRatioPercent).toBe(0.03);
  expect(row.price).toBe(685.3);
  expect(row.marketPrice).toBe(685.26);
  expect(row.premiumDiscountPercent).toBe(-0.15);
  expect(row.yieldPercent).toBe(1.03);
  expect(row.high52wPrice).toBe(698.14);
  expect(row.low52wPrice).toBe(571.66);
  expect(row.inceptionDate).toBe(Math.floor(Date.UTC(2010, 8, 7) / 1000));
  // from performance
  expect(row.return1yPercent).toBe(22.28);
  expect(row.return10yPercent).toBe(15.47);
  expect(row.benchmarkReturn1yPercent).toBe(22.32);
  // from risk
  expect(row.primaryBenchmark).toBe("S&P 500 Index");
  expect(row.beta).toBe(1.0);
  expect(row.rSquared).toBe(1.0);
  expect(row.riskLevel).toBe("Moderate to Aggressive");
});

test("parseFundDetails degrades to nulls on empty envelopes", () => {
  const row = parseFundDetails({}, {}, {}, {});
  expect(row.ticker).toBeNull();
  expect(row.price).toBeNull();
  expect(row.beta).toBeNull();
  expect(row.primaryBenchmark).toBeNull();
});

test("parseDistributions maps items and parses the $-prefixed amount", () => {
  const rows = parseDistributions(distributionEnvelope());
  expect(rows.length).toBe(2);
  const d0 = rows[0]!;
  expect(d0.distributionType).toBe("Dividend");
  expect(d0.perShareAmount).toBe(1.9622);
  expect(d0.recordDate).toBe(Math.floor(Date.UTC(2026, 5, 26) / 1000));
  expect(d0.payableDate).toBe(Math.floor(Date.UTC(2026, 5, 30) / 1000));
  expect(d0.reinvestPrice).toBe(673.33);
});

test("parseDistributions bounds rows by record date [start, end]", () => {
  const start = Math.floor(Date.UTC(2026, 3, 1) / 1000); // Apr 1 2026 → drops the Mar 27 row
  const rows = parseDistributions(distributionEnvelope(), start, null);
  expect(rows.length).toBe(1);
  expect(rows[0]!.recordDate).toBe(Math.floor(Date.UTC(2026, 5, 26) / 1000));
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

test("fetchFundDetails requests all four components", async () => {
  const fake = FakeVanguard.router({
    profile: profileEnvelope(),
    price: priceEnvelope(),
    performance: performanceEnvelope(),
    risk: riskEnvelope(),
  });
  const row = await fetchFundDetails(fake.get, "VOO");
  expect(row.beta).toBe(1.0);
  expect(fake.calls.length).toBe(4);
  expect(fake.calls.some((u) => u.endsWith("/profile"))).toBe(true);
  expect(fake.calls.some((u) => u.endsWith("/price"))).toBe(true);
  expect(fake.calls.some((u) => u.endsWith("/performance"))).toBe(true);
  expect(fake.calls.some((u) => u.endsWith("/risk"))).toBe(true);
});

test("fetchDistributions reads the distribution component", async () => {
  const fake = FakeVanguard.router({ distribution: distributionEnvelope() });
  const rows = await fetchDistributions(fake.get, "VOO");
  expect(rows.length).toBe(2);
  expect(fake.calls[0]).toContain("/distribution");
});

test("fetchNavHistory hits the price-history endpoint for the requested period", async () => {
  const fake = FakeVanguard.router({ priceHistory: (p) => priceHistoryEnvelope(p) });
  const rows = await fetchNavHistory(fake.get, "VOO", "10Y");
  expect(rows.length).toBe(2);
  expect(fake.calls[0]).toContain("/price-history/10Y");
});

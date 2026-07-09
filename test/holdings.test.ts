// Archetype proof for vanguard.holdings: the portfolio-holding driver + fund resolution +
// DATE-arg conversion. SDK-free.

import { test, expect } from "bun:test";
import {
  parseHoldings,
  fetchHoldings,
  resolveFund,
  dateArgToEpoch,
  holdingsUrl,
  componentUrl,
} from "../src/vanguard.js";
import {
  FakeVanguard,
  catalogEnvelope,
  stockHoldingsEnvelope,
  bondHoldingsEnvelope,
} from "./fake-vanguard.js";

test("holdingsUrl / componentUrl carry the ticker and the paging count", () => {
  expect(componentUrl("voo", "profile")).toContain("/api/VOO/profile");
  const u = holdingsUrl("voo", "stock");
  expect(u).toContain("/api/VOO/portfolio-holding/stock");
  expect(u).toContain("count=50000");
  expect(holdingsUrl("bnd", "bond")).toContain("/portfolio-holding/bond");
});

test("dateArgToEpoch returns epoch seconds at UTC midnight (from epoch-ms), null when absent", () => {
  expect(dateArgToEpoch(Date.UTC(2025, 0, 1))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(new Date(Date.UTC(2025, 0, 1)))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(Math.floor(Date.UTC(2025, 0, 1) / 86400000))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch("2025-01-01")).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(null)).toBeNull();
});

test("parseHoldings maps stock constituents, tolerates blank cells, tags the fund", () => {
  const rows = parseHoldings(stockHoldingsEnvelope(), "VOO");
  expect(rows.length).toBe(2);
  const nvda = rows[0]!;
  expect(nvda.fundTicker).toBe("VOO");
  expect(nvda.ticker).toBe("NVDA");
  expect(nvda.name).toBe("NVIDIA Corp.");
  expect(nvda.weightPercent).toBe(7.89);
  expect(nvda.marketValue).toBe(134324172898.74);
  expect(nvda.sharesHeld).toBe(636185341);
  expect(nvda.asOfDate).toBe(Math.floor(Date.UTC(2026, 4, 31) / 1000));
  // equity holdings leave the bond-only columns null
  expect(nvda.couponPercent).toBeNull();
  expect(nvda.maturity).toBeNull();
  expect(rows[1]!.sedol).toBeNull(); // blank cell
});

test("parseHoldings sorts by weight descending (NULLS last)", () => {
  const rows = parseHoldings(stockHoldingsEnvelope(), "VOO");
  expect(rows.map((r) => r.ticker)).toEqual(["NVDA", "AAPL"]);
  expect(rows[0]!.weightPercent!).toBeGreaterThanOrEqual(rows[1]!.weightPercent!);
});

test("parseHoldings fills coupon / maturity / face for bond funds", () => {
  const rows = parseHoldings(bondHoldingsEnvelope(), "BND");
  expect(rows.length).toBe(2);
  const b0 = rows[0]!;
  expect(b0.couponPercent).toBe(2.0);
  expect(b0.maturity).toBe("11/01/2027-06/01/2056"); // aggregated range kept as raw text
  expect(b0.faceAmount).toBe(6751682408);
});

test("parseHoldings returns [] for an empty/unknown envelope, no throw", () => {
  expect(parseHoldings({}, "VOO")).toEqual([]);
  expect(parseHoldings({ fund: { entity: [] } }, "VOO")).toEqual([]);
});

test("resolveFund maps a ticker via the catalog (canonical upper-case)", async () => {
  const fake = new FakeVanguard(() => catalogEnvelope());
  expect(await resolveFund(fake.get, "voo")).toBe("VOO");
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("/list/funddetail/");
});

test("resolveFund resolves a mutual-fund ticker too (etfOnly=false internally)", async () => {
  const fake = new FakeVanguard(() => catalogEnvelope());
  expect(await resolveFund(fake.get, "VFIAX")).toBe("VFIAX");
});

test("resolveFund returns null on an unknown ticker (caller raises the typed error)", async () => {
  const fake = new FakeVanguard(() => catalogEnvelope());
  expect(await resolveFund(fake.get, "ZZZZ")).toBeNull();
});

test("fetchHoldings for an equity fund hits the stock endpoint once", async () => {
  const fake = FakeVanguard.router({ holdingsStock: stockHoldingsEnvelope() });
  const rows = await fetchHoldings(fake.get, "VOO", false);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("/portfolio-holding/stock");
});

test("fetchHoldings for a bond fund hits the bond endpoint", async () => {
  const fake = FakeVanguard.router({ holdingsBond: bondHoldingsEnvelope() });
  const rows = await fetchHoldings(fake.get, "BND", true);
  expect(rows.length).toBe(2);
  expect(fake.calls.some((u) => u.includes("/portfolio-holding/bond"))).toBe(true);
});

test("fetchHoldings falls back to the other breakdown when the primary is empty", async () => {
  // Equity-classified fund whose stock breakdown is empty → falls back to bond.
  const fake = FakeVanguard.router({ holdingsStock: {}, holdingsBond: bondHoldingsEnvelope() });
  const rows = await fetchHoldings(fake.get, "BND", false);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(2);
  expect(fake.calls[0]).toContain("/portfolio-holding/stock");
  expect(fake.calls[1]).toContain("/portfolio-holding/bond");
});

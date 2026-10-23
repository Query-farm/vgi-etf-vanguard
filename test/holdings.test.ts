// Archetype proof for vanguard.holdings: the AdditionalFundData holdings driver + fund resolution +
// DATE-arg conversion. SDK-free.

import { test, expect } from "bun:test";
import {
  parseHoldings,
  fetchHoldings,
  resolveFund,
  dateArgToEpoch,
  holdingsUrl,
  fundDataUrl,
  isoDate,
} from "../src/vanguard.js";
import {
  FakeVanguard,
  catalogEnvelope,
  stockHoldingsEnvelope,
  bondHoldingsEnvelope,
} from "./fake-vanguard.js";

test("holdingsUrl / fundDataUrl target the irr/funds/profile plane with the upper-cased ticker", () => {
  expect(fundDataUrl("voo")).toBe("https://investor.vanguard.com/irr/funds/profile/VOO.json");
  expect(holdingsUrl("bnd")).toBe("https://investor.vanguard.com/irr/funds/profile/BND-AdditionalFundData");
});

test("isoDate accepts ISO and US MM/DD/YYYY, rejects impossible dates", () => {
  expect(isoDate("09/30/2026")).toBe(Math.floor(Date.UTC(2026, 8, 30) / 1000));
  expect(isoDate("2026-09-30T00:00:00-04:00")).toBe(Math.floor(Date.UTC(2026, 8, 30) / 1000));
  expect(isoDate("02/30/2026")).toBeNull();
  expect(isoDate("11/01/2027-06/01/2056")).toBeNull();
});

test("dateArgToEpoch returns epoch seconds at UTC midnight (from epoch-ms), null when absent", () => {
  expect(dateArgToEpoch(Date.UTC(2025, 0, 1))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(new Date(Date.UTC(2025, 0, 1)))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(Math.floor(Date.UTC(2025, 0, 1) / 86400000))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch("2025-01-01")).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(null)).toBeNull();
});

test("parseHoldings maps every holding group, tolerates blank cells, tags the fund", () => {
  const rows = parseHoldings(stockHoldingsEnvelope(), "VOO");
  expect(rows.length).toBe(4); // 2 equity + 1 short-term reserve + 1 derivative
  const nvda = rows[0]!;
  expect(nvda.fundTicker).toBe("VOO");
  expect(nvda.ticker).toBe("NVDA");
  expect(nvda.name).toBe("NVIDIA Corp");
  expect(nvda.weightPercent).toBe(8.39);
  expect(nvda.marketValue).toBe(145149632888);
  expect(nvda.sharesHeld).toBe(635561927);
  expect(nvda.secType).toBe("EQ.STOCK");
  expect(nvda.asOfDate).toBe(Math.floor(Date.UTC(2026, 8, 30) / 1000));
  // equity holdings leave the debt-only columns null (Vanguard sends a bogus face/coupon)
  expect(nvda.couponPercent).toBeNull();
  expect(nvda.maturity).toBeNull();
  expect(nvda.faceAmount).toBeNull();
  expect(rows[1]!.sedol).toBeNull(); // AAPL: blank cell
  const cash = rows.find((r) => r.secType === "MM.CASH")!;
  expect(cash.couponPercent).toBe(5.359);
  expect(cash.maturity).toBe("12/31/2999");
  expect(rows.find((r) => r.secType === "DE.IND")!.faceAmount).toBeNull();
});

test("parseHoldings sorts by weight descending (NULLS last)", () => {
  const rows = parseHoldings(stockHoldingsEnvelope(), "VOO");
  expect(rows.map((r) => r.ticker)).toEqual(["NVDA", "AAPL", null, "ESZ6"]);
  expect(rows[0]!.weightPercent!).toBeGreaterThanOrEqual(rows[1]!.weightPercent!);
});

test("parseHoldings fills coupon / maturity / face for bond funds", () => {
  const rows = parseHoldings(bondHoldingsEnvelope(), "BND");
  expect(rows.length).toBe(2);
  const b0 = rows[0]!;
  expect(b0.couponPercent).toBe(4.25);
  expect(b0.maturity).toBe("11/15/2034"); // kept as raw text
  expect(b0.faceAmount).toBe(1722038000);
  expect(rows[1]!.ticker).toBeNull();
});

test("parseHoldings returns [] for an empty/unknown envelope, no throw", () => {
  expect(parseHoldings({}, "VOO")).toEqual([]);
  expect(parseHoldings({ holdingDetails: { equityHoldings: [] } }, "VOO")).toEqual([]);
  expect(parseHoldings(null, "VOO")).toEqual([]);
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

test("fetchHoldings reads the AdditionalFundData document once", async () => {
  const fake = FakeVanguard.router({ additional: stockHoldingsEnvelope() });
  const rows = await fetchHoldings(fake.get, "voo");
  expect(rows.length).toBe(4);
  expect(rows.every((r) => r.fundTicker === "VOO")).toBe(true);
  expect(fake.calls).toEqual(["https://investor.vanguard.com/irr/funds/profile/VOO-AdditionalFundData"]);
});

test("fetchHoldings for a bond fund maps its fixed-income holdings", async () => {
  const fake = FakeVanguard.router({ additional: bondHoldingsEnvelope() });
  const rows = await fetchHoldings(fake.get, "BND");
  expect(rows.length).toBe(2);
  expect(rows[0]!.secType).toBe("FI.US_GOV");
});

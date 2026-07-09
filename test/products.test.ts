// Archetype proof for vanguard.products: the funddetail/all catalog driver. Imports ONLY our own
// src + the fake — NO @query-farm/* — so it runs without the SDK installed. Proves value coercion
// (string numbers, "$"/"%" stripping, ISO dates), ETF filtering, and the catalog URL contract.

import { test, expect } from "bun:test";
import { parseProducts, fetchProducts, num, str, isoDate, LIST_URL } from "../src/vanguard.js";
import { FakeVanguard, catalogEnvelope } from "./fake-vanguard.js";

test("num strips $/,/% and parses string numbers, rejects blanks", () => {
  expect(num("0.0300")).toBe(0.03);
  expect(num("$1.962200")).toBe(1.9622);
  expect(num("-0.15")).toBe(-0.15);
  expect(num("1,182,200")).toBe(1182200);
  expect(num(685.3)).toBe(685.3);
  expect(num("")).toBeNull();
  expect(num("  ")).toBeNull();
  expect(num(null)).toBeNull();
});

test("str trims and nulls blanks", () => {
  expect(str("  VOO ")).toBe("VOO");
  expect(str("")).toBeNull();
  expect(str("   ")).toBeNull();
  expect(str(null)).toBeNull();
});

test("isoDate keeps only the calendar day (zone offset can't shift it)", () => {
  expect(isoDate("2026-05-31T00:00:00-04:00")).toBe(Math.floor(Date.UTC(2026, 4, 31) / 1000));
  expect(isoDate("2010-09-07T00:00:00-04:00")).toBe(Math.floor(Date.UTC(2010, 8, 7) / 1000));
  expect(isoDate("2026-05-31")).toBe(Math.floor(Date.UTC(2026, 4, 31) / 1000));
  expect(isoDate("")).toBeNull();
  expect(isoDate("not a date")).toBeNull();
  expect(isoDate("2026-13-45T00:00:00Z")).toBeNull(); // impossible parts → null
});

test("parseProducts maps an ETF and defaults to ETF-only", () => {
  const rows = parseProducts(catalogEnvelope());
  expect(rows.length).toBe(2); // the mutual fund (VFIAX) is filtered out
  const voo = rows.find((r) => r.ticker === "VOO")!;
  expect(voo.fundId).toBe("0968");
  expect(voo.longName).toBe("Vanguard S&P 500 ETF");
  expect(voo.assetClass).toBe("Equity");
  expect(voo.expenseRatioPercent).toBe(0.03);
  expect(voo.price).toBe(685.3);
  expect(voo.yieldPercent).toBe(1.03);
  expect(voo.return1yPercent).toBe(22.28);
  expect(voo.return10yPercent).toBe(15.47);
  expect(voo.inceptionDate).toBe(Math.floor(Date.UTC(2010, 8, 7) / 1000));
  expect(voo.riskCode).toBe(4);
  expect(voo.primaryBenchmark).toBe("S&P 500 Index");
  expect(voo.productPageUrl).toBe("/investment-products/etfs/profile/voo");
  expect(voo.isBond).toBe(false);
});

test("parseProducts classifies a bond ETF and flags isBond", () => {
  const bnd = parseProducts(catalogEnvelope()).find((r) => r.ticker === "BND")!;
  expect(bnd.assetClass).toBe("Fixed Income");
  expect(bnd.isBond).toBe(true);
});

test("parseProducts etfOnly=false includes every product type; ticker narrows", () => {
  expect(parseProducts(catalogEnvelope(), false).length).toBe(3);
  const one = parseProducts(catalogEnvelope(), false, "vfiax");
  expect(one.length).toBe(1);
  expect(one[0]!.ticker).toBe("VFIAX");
  expect(one[0]!.assetClass).toBe("Equity");
  expect(parseProducts(catalogEnvelope(), false, "ZZZZ")).toEqual([]);
});

test("parseProducts tolerates junk without throwing", () => {
  expect(parseProducts(null)).toEqual([]);
  expect(parseProducts({ x: 1 })).toEqual([]);
  expect(parseProducts({ fund: { entity: [] } })).toEqual([]);
});

test("fetchProducts hits the catalog URL once", async () => {
  const fake = new FakeVanguard(() => catalogEnvelope());
  const rows = await fetchProducts(fake.get);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toBe(LIST_URL);
});

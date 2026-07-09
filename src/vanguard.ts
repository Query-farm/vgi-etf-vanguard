// The Vanguard driver — pure logic, no network and no SDK. Every fetch* takes an injected
// `get(url) => Promise<any>` so the archetype-proof tests drive it against an in-process fake
// and the worker wires the real HTTP client (client.ts). This module MUST NOT import from
// @query-farm/* — the unit tests import it without the SDK installed.
//
// Vanguard exposes a KEYLESS, component-based public JSON API (like iShares' get-product-data,
// but shaped differently). Two planes back the tables and functions:
//
//   /investment-products/list/funddetail/all           → products  (one big catalog object with
//     an entity per fund: profile, price, yield, returns, risk)
//   /investment-products/etfs/profile/api/<T>/<comp>    → holdings, fund_details, distributions
//     (per-fund components: profile, price, portfolio-holding/{stock,bond}, distribution,
//      performance, risk)
//   /vmf/api/<T>/price-history/<period>                 → nav_history (daily/weekly/monthly NAV
//      + market-price series over a fixed period window)
//
// Every parser is defensive: a missing key / container / array degrades to an empty result or a
// null cell rather than throwing. `resolveFund` returns null (not a throw) on an unresolvable
// ticker so the caller (functions.ts) can raise a typed SDK error.
//
// Vanguard values arrive as JSON strings far more often than numbers ("0.0300", "$1.96",
// "570.22", "-0.15"); `num()` strips the `$`/`,`/`%` decoration and parses. Dates arrive as ISO
// timestamps with an offset ("2026-05-31T00:00:00-04:00"); `isoDate()` keeps only the calendar
// day (the leading YYYY-MM-DD) as epoch SECONDS at UTC midnight — the driver returns dates as
// epoch seconds and the Arrow DATE mapping lives in schema.ts (keeping this module type/SDK-free).
//
// IMPORTANT — Vanguard holdings are CURRENT-only: each fund reports a single as-of date, with no
// arbitrary historical as-of. So `holdings` is hive-partitioned by fund but has NO time travel.

export const VANGUARD_HOST = "https://investor.vanguard.com";

/** The full product catalog: one big JSON object with an entity per fund. */
export const LIST_URL = `${VANGUARD_HOST}/investment-products/list/funddetail/all`;

// ── shared value coercion ────────────────────────────────────────────────────

/** True for Vanguard's "no data" cells: null, "", or all-whitespace. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/** A trimmed display string, or null when blank. */
export function str(v: unknown): string | null {
  if (isBlank(v)) return null;
  return String(v).trim();
}

/**
 * A number from a Vanguard value. Handles bare numbers and the common string forms
 * ("0.0300", "$1.962200", "570.22", "-0.15", "1,182,200"). Strips `$`, `,`, `%`, and spaces.
 * Null when blank / non-numeric.
 */
export function num(v: unknown): number | null {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * A Vanguard ISO date ("2026-05-31T00:00:00-04:00" or "2026-05-31") → epoch SECONDS at UTC
 * midnight of the CALENDAR day. We keep only the leading YYYY-MM-DD so the zone offset can never
 * shift the reported day. Null when absent / unparseable. Validates the parts round-trip, so an
 * impossible date returns null.
 */
export function isoDate(v: unknown): number | null {
  if (isBlank(v)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

// ── DATE-typed function arguments ──────────────────────────────────────────────
//
// Date args on the table functions are real SQL DATE (Arrow Date32), so DuckDB parses and
// type-checks the literal and the SDK hands us a value — no YYYY-MM-DD strings on the SQL
// surface. `dateArgToEpoch` accepts the runtime's epoch-ms number (verified: `DATE '2026-01-01'`
// → 1767225600000) plus, defensively, a JS Date, a bigint, a days-since-epoch number, or a
// YYYY-MM-DD/YYYYMMDD string, so it is robust to the representation. Used only for the
// client-side start_date/end_date range filters (Vanguard URLs carry no date parameter).

/** A DATE arg → epoch SECONDS at UTC midnight, or null when absent/invalid. */
export function dateArgToEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(t);
    if (!m) return null;
    return isoDate(`${m[1]}-${m[2]}-${m[3]}`);
  }
  let ms: number;
  if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "bigint") ms = Number(v);
  else if (typeof v === "number" && Number.isFinite(v)) {
    // Disambiguate by magnitude: >= 1e11 is epoch milliseconds; smaller is days-since-epoch.
    ms = Math.abs(v) >= 1e11 ? v : v * 86400000;
  } else return null;
  return Number.isNaN(ms) ? null : Math.floor(ms / 86400000) * 86400;
}

// ── products (the funddetail/all catalog) ──────────────────────────────────────

export interface ProductRow {
  ticker: string | null;
  fundId: string | null;
  cusip: string | null;
  shortName: string | null;
  longName: string | null;
  assetClass: string | null;
  category: string | null;
  style: string | null;
  managementStyle: string | null;
  inceptionDate: number | null;
  expenseRatioPercent: number | null;
  price: number | null;
  priceAsOf: number | null;
  marketPrice: number | null;
  yieldPercent: number | null;
  yieldAsOf: number | null;
  ytdReturnPercent: number | null;
  return1mPercent: number | null;
  return3mPercent: number | null;
  return1yPercent: number | null;
  return3yPercent: number | null;
  return5yPercent: number | null;
  return10yPercent: number | null;
  returnSinceInceptionPercent: number | null;
  riskLevel: string | null;
  riskCode: number | null;
  primaryBenchmark: string | null;
  productPageUrl: string | null;
  /** Internal only (not an emitted column): whether this is a bond fund (picks the holdings endpoint). */
  isBond: boolean;
}

/** Normalize a Vanguard fund's asset class from its fundFact flags / style. */
function assetClassOf(profile: Record<string, unknown>): string | null {
  const fact = (profile.fundFact as Record<string, unknown> | undefined) ?? {};
  if (fact.isStock) return "Equity";
  if (fact.isBond) return "Fixed Income";
  if (fact.isBalanced) return "Balanced";
  if (fact.isMoneyMarket) return "Money Market";
  const style = str(profile.style);
  if (style === "Stock Funds") return "Equity";
  if (style === "Bond Funds") return "Fixed Income";
  return style;
}

/** Build the public fund page path on investor.vanguard.com from a ticker. */
export function productPageUrl(ticker: string | null): string | null {
  if (!ticker) return null;
  return `/investment-products/etfs/profile/${ticker.toLowerCase()}`;
}

/** Map one catalog entity (which nests `profile`, `risk`, `dailyPrice`, `yield`, returns) to a row. */
function parseProductEntity(entity: unknown): ProductRow | null {
  if (entity == null || typeof entity !== "object") return null;
  const e = entity as Record<string, unknown>;
  const profile = e.profile as Record<string, unknown> | undefined;
  if (!profile || typeof profile !== "object") return null;
  const risk = (e.risk as Record<string, unknown> | undefined) ?? {};
  const vol = (risk.volatility as Record<string, unknown> | undefined) ?? {};
  const dailyPrice = (e.dailyPrice as Record<string, unknown> | undefined) ?? {};
  const regular = (dailyPrice.regular as Record<string, unknown> | undefined) ?? {};
  const market = (dailyPrice.market as Record<string, unknown> | undefined) ?? {};
  const yld = (e.yield as Record<string, unknown> | undefined) ?? {};
  const ytd = (e.ytd as Record<string, unknown> | undefined) ?? {};
  const ret =
    ((e.monthEndAvgAnnualRtn as Record<string, unknown> | undefined)?.fundReturn as
      | Record<string, unknown>
      | undefined) ?? {};
  const ticker = str(profile.ticker);
  const fact = (profile.fundFact as Record<string, unknown> | undefined) ?? {};
  return {
    ticker,
    fundId: str(profile.fundId),
    cusip: str(profile.cusip),
    shortName: str(profile.shortName),
    longName: str(profile.longName),
    assetClass: assetClassOf(profile),
    category: str(profile.category),
    style: str(profile.customizedStyle) ?? str(profile.style),
    managementStyle: str(profile.fundManagementStyle),
    inceptionDate: isoDate(profile.inceptionDate),
    expenseRatioPercent: num(profile.expenseRatio),
    price: num(regular.price),
    priceAsOf: isoDate(regular.asOfDate),
    marketPrice: num(market.price),
    yieldPercent: num(yld.yieldPct),
    yieldAsOf: isoDate(yld.asOfDate),
    ytdReturnPercent: num(ytd.regular),
    return1mPercent: num(ret.prevMonthPct),
    return3mPercent: num(ret.threeMonthPct),
    return1yPercent: num(ret.oneYrPct),
    return3yPercent: num(ret.threeYrPct),
    return5yPercent: num(ret.fiveYrPct),
    return10yPercent: num(ret.tenYrPct),
    returnSinceInceptionPercent: num(ret.sinceInceptionPct),
    riskLevel: str(risk.level),
    riskCode: num(risk.code),
    primaryBenchmark: str(vol.primaryBenchmarkName),
    productPageUrl: productPageUrl(ticker),
    isBond: Boolean(fact.isBond),
  };
}

/**
 * Map the funddetail/all envelope to product rows. `etfOnly` (default true) keeps only ETFs
 * (`profile.isETF`); pass false to include every product type. `ticker`, when non-empty, narrows
 * to that one ticker (case-insensitive).
 */
export function parseProducts(json: unknown, etfOnly = true, ticker = ""): ProductRow[] {
  const entities = (json as { fund?: { entity?: unknown } } | null | undefined)?.fund?.entity;
  if (!Array.isArray(entities)) return [];
  const wantTicker = ticker.trim().toUpperCase();
  const rows: ProductRow[] = [];
  for (const entity of entities) {
    const profile = (entity as Record<string, unknown> | null | undefined)?.profile as
      | Record<string, unknown>
      | undefined;
    if (!profile) continue;
    if (etfOnly && !profile.isETF) continue;
    const row = parseProductEntity(entity);
    if (!row || !row.ticker) continue;
    if (wantTicker && row.ticker.toUpperCase() !== wantTicker) continue;
    rows.push(row);
  }
  return rows;
}

export async function fetchProducts(
  get: (url: string) => Promise<unknown>,
  etfOnly = true,
  ticker = "",
): Promise<ProductRow[]> {
  return parseProducts(await get(LIST_URL), etfOnly, ticker);
}

// ── fund resolution (accept a ticker; validate against the catalog) ─────────────

/**
 * Resolve a `fund` argument (an ETF ticker like 'VOO') to its canonical, upper-cased ticker.
 * Vanguard's per-fund endpoints are keyed by ticker, so this validates against the catalog (one
 * cached fetch) and normalizes casing. Returns null when the ticker can't be found (the caller
 * raises a typed ArgumentValidationError — this module stays SDK-free).
 */
export async function resolveFund(
  get: (url: string) => Promise<unknown>,
  fund: string,
): Promise<string | null> {
  const wanted = fund.trim().toUpperCase();
  if (wanted === "") return null;
  const products = parseProducts(await get(LIST_URL), false);
  const hit = products.find((p) => (p.ticker ?? "").toUpperCase() === wanted);
  return hit ? (hit.ticker as string).toUpperCase() : null;
}

// ── per-fund component plumbing ─────────────────────────────────────────────────

/** Build a per-fund profile-API component URL (profile, price, distribution, performance, risk). */
export function componentUrl(ticker: string, component: string): string {
  return `${VANGUARD_HOST}/investment-products/etfs/profile/api/${encodeURIComponent(
    ticker.toUpperCase(),
  )}/${component}`;
}

/** Build a portfolio-holding URL for the stock or bond breakdown, asking for every lot in one page. */
export function holdingsUrl(ticker: string, kind: "stock" | "bond"): string {
  return `${componentUrl(ticker, `portfolio-holding/${kind}`)}?start=1&count=50000`;
}

/** Build a price-history URL for a period window (1M / 1Y / 5Y / 10Y). */
export function priceHistoryUrl(ticker: string, period: string): string {
  return `${VANGUARD_HOST}/vmf/api/${encodeURIComponent(ticker.toUpperCase())}/price-history/${period}`;
}

/** Reach the `fund.entity` array of a portfolio-holding envelope, or []. */
function entityArray(json: unknown): unknown[] {
  const e = (json as { fund?: { entity?: unknown } } | null | undefined)?.fund?.entity;
  return Array.isArray(e) ? e : [];
}

// ── holdings (portfolio-holding/{stock,bond}) ───────────────────────────────────

export interface HoldingRow {
  /** The fund's ticker — the partition key (constant per fund; distinct from the constituent `ticker`). */
  fundTicker: string | null;
  asOfDate: number | null;
  name: string | null;
  ticker: string | null;
  isin: string | null;
  cusip: string | null;
  sedol: string | null;
  weightPercent: number | null;
  marketValue: number | null;
  sharesHeld: number | null;
  notionalValue: number | null;
  secType: string | null;
  // Fixed-income-only fields (null for equity funds).
  couponPercent: number | null;
  maturity: string | null;
  faceAmount: number | null;
}

/** Map a portfolio-holding envelope to holding rows, sorted by weight desc (NULLS last). */
export function parseHoldings(json: unknown, fundTicker: string | null = null): HoldingRow[] {
  const rows: HoldingRow[] = [];
  for (const raw of entityArray(json)) {
    if (raw == null || typeof raw !== "object") continue;
    const h = raw as Record<string, unknown>;
    const secType = [str(h.secMainType), str(h.secSubType)].filter((s) => s).join(" / ") || null;
    rows.push({
      fundTicker,
      asOfDate: isoDate(h.asOfDate),
      name: str(h.longName) ?? str(h.shortName),
      ticker: str(h.ticker),
      isin: str(h.isin),
      cusip: str(h.cusip),
      sedol: str(h.sedol),
      weightPercent: num(h.percentWeight),
      marketValue: num(h.marketValue),
      sharesHeld: num(h.sharesHeld),
      notionalValue: num(h.notionalValue),
      secType,
      couponPercent: num(h.couponRate),
      maturity: str(h.maturityDate),
      faceAmount: num(h.faceAmount),
    });
  }
  // Vanguard returns holdings weight-descending; enforce it so `... LIMIT 10` is the top
  // holdings without an explicit ORDER BY. NULL weights sort last.
  rows.sort((a, b) => (b.weightPercent ?? -Infinity) - (a.weightPercent ?? -Infinity));
  return rows;
}

/**
 * Detailed current holdings for one fund. A bond fund's constituents live under the `bond`
 * breakdown, an equity fund's under `stock`; `isBond` (from the catalog) picks the primary
 * endpoint, and if it comes back empty we fall back to the other so a balanced/misclassified
 * fund still resolves. Returns the aggregated positions Vanguard publishes (one as-of date).
 */
export async function fetchHoldings(
  get: (url: string) => Promise<unknown>,
  fundTicker: string,
  isBond = false,
): Promise<HoldingRow[]> {
  const primary: "stock" | "bond" = isBond ? "bond" : "stock";
  const other: "stock" | "bond" = isBond ? "stock" : "bond";
  let rows = parseHoldings(await get(holdingsUrl(fundTicker, primary)), fundTicker.toUpperCase());
  if (rows.length === 0) {
    rows = parseHoldings(await get(holdingsUrl(fundTicker, other)), fundTicker.toUpperCase());
  }
  return rows;
}

// ── fund_details (profile + price + performance + risk, merged to one row) ───────

export interface FundDetailsRow {
  ticker: string | null;
  fundId: string | null;
  cusip: string | null;
  longName: string | null;
  shortName: string | null;
  assetClass: string | null;
  category: string | null;
  managementStyle: string | null;
  inceptionDate: number | null;
  expenseRatioPercent: number | null;
  price: number | null;
  priceAsOf: number | null;
  marketPrice: number | null;
  premiumDiscountPercent: number | null;
  yieldPercent: number | null;
  yieldAsOf: number | null;
  high52wPrice: number | null;
  low52wPrice: number | null;
  ytdReturnPercent: number | null;
  return1yPercent: number | null;
  return3yPercent: number | null;
  return5yPercent: number | null;
  return10yPercent: number | null;
  returnSinceInceptionPercent: number | null;
  primaryBenchmark: string | null;
  benchmarkReturn1yPercent: number | null;
  beta: number | null;
  rSquared: number | null;
  riskLevel: string | null;
}

/**
 * Merge the profile / price / performance / risk envelopes into one fund-details row. Everything
 * is optional and degrades to nulls; `profile` supplies the identity/expense/inception, `price`
 * the quote/premium/52-week band, `performance` the annualized returns + benchmark, and `risk`
 * the level/beta/R².
 */
export function parseFundDetails(
  profile: unknown,
  price: unknown,
  performance: unknown,
  risk: unknown,
): FundDetailsRow {
  const p = ((profile as { fundProfile?: unknown } | null | undefined)?.fundProfile ??
    {}) as Record<string, unknown>;
  const current = ((price as { currentPrice?: unknown } | null | undefined)?.currentPrice ??
    {}) as Record<string, unknown>;
  const daily = (current.dailyPrice as Record<string, unknown> | undefined) ?? {};
  const regular = (daily.regular as Record<string, unknown> | undefined) ?? {};
  const market = (daily.market as Record<string, unknown> | undefined) ?? {};
  const yld = (current.yield as Record<string, unknown> | undefined) ?? {};
  const highLowReg =
    (((current.highLow as Record<string, unknown> | undefined) ?? {}).regular as
      | Record<string, unknown>
      | undefined) ?? {};
  const recent =
    ((performance as { recentInvestmentRtn?: unknown } | null | undefined)?.recentInvestmentRtn ??
      {}) as Record<string, unknown>;
  const fundReturn = (recent.fundReturn as Record<string, unknown> | undefined) ?? {};
  const benchReturn = (recent.benchmarkReturn as Record<string, unknown> | undefined) ?? {};
  const r = (risk as Record<string, unknown> | null | undefined) ?? {};
  const vol = (r.volatility as Record<string, unknown> | undefined) ?? {};
  const ticker = str(p.ticker);
  return {
    ticker,
    fundId: str(p.fundId),
    cusip: str(p.cusip),
    longName: str(p.longName),
    shortName: str(p.shortName),
    assetClass: assetClassOf(p),
    category: str(p.category),
    managementStyle: str(p.fundManagementStyle),
    inceptionDate: isoDate(p.inceptionDate),
    expenseRatioPercent: num(p.expenseRatio),
    price: num(regular.price),
    priceAsOf: isoDate(regular.asOfDate),
    marketPrice: num(market.price),
    premiumDiscountPercent: num(current.premiumOrDiscount),
    yieldPercent: num(yld.yieldPct),
    yieldAsOf: isoDate(yld.asOfDate),
    high52wPrice: num(highLowReg.highPrice),
    low52wPrice: num(highLowReg.lowPrice),
    ytdReturnPercent: num(fundReturn.calendarYTDPct),
    return1yPercent: num(fundReturn.oneYrPct),
    return3yPercent: num(fundReturn.threeYrPct),
    return5yPercent: num(fundReturn.fiveYrPct),
    return10yPercent: num(fundReturn.tenYrPct),
    returnSinceInceptionPercent: num(fundReturn.sinceInceptionPct),
    primaryBenchmark: str(vol.primaryBenchmarkName) ?? str(recent.benchmarkShortName),
    benchmarkReturn1yPercent: num(benchReturn.oneYrPct),
    beta: num(vol.betaPrimary),
    rSquared: num(vol.rSquaredPrimary),
    riskLevel: str(r.level),
  };
}

export async function fetchFundDetails(
  get: (url: string) => Promise<unknown>,
  fundTicker: string,
): Promise<FundDetailsRow> {
  const [profile, price, performance, risk] = await Promise.all([
    get(componentUrl(fundTicker, "profile")),
    get(componentUrl(fundTicker, "price")),
    get(componentUrl(fundTicker, "performance")),
    get(componentUrl(fundTicker, "risk")),
  ]);
  return parseFundDetails(profile, price, performance, risk);
}

// ── distributions (component "distribution", container divCapGain.item) ──────────

export interface DistributionRow {
  recordDate: number | null;
  reinvestmentDate: number | null;
  payableDate: number | null;
  distributionType: string | null;
  perShareAmount: number | null;
  reinvestPrice: number | null;
}

/** Map a distribution envelope's divCapGain items, optionally bounded to [startSec, endSec] by record date. */
export function parseDistributions(
  json: unknown,
  startSec: number | null = null,
  endSec: number | null = null,
): DistributionRow[] {
  const items = (
    (json as { divCapGain?: { item?: unknown } } | null | undefined)?.divCapGain?.item
  );
  if (!Array.isArray(items)) return [];
  const rows: DistributionRow[] = [];
  for (const raw of items) {
    if (raw == null || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const recordDate = isoDate(it.recordDate);
    if (startSec != null && (recordDate == null || recordDate < startSec)) continue;
    if (endSec != null && (recordDate == null || recordDate > endSec)) continue;
    rows.push({
      recordDate,
      reinvestmentDate: isoDate(it.reinvestmentDate),
      payableDate: isoDate(it.payableDate),
      distributionType: str(it.type),
      perShareAmount: num(it.perShareAmount),
      reinvestPrice: num(it.reinvestPrice),
    });
  }
  return rows;
}

export async function fetchDistributions(
  get: (url: string) => Promise<unknown>,
  fundTicker: string,
  startSec: number | null = null,
  endSec: number | null = null,
): Promise<DistributionRow[]> {
  return parseDistributions(await get(componentUrl(fundTicker, "distribution")), startSec, endSec);
}

// ── nav_history (vmf price-history, nav + marketPrice series over a period) ───────

/** Allowed price-history period windows (Vanguard's public options). */
export const NAV_PERIODS = ["1M", "1Y", "5Y", "10Y"] as const;
export type NavPeriod = (typeof NAV_PERIODS)[number];
export const DEFAULT_NAV_PERIOD: NavPeriod = "1Y";

/** Normalize a period arg to a supported window (case-insensitive); default when blank/unknown. */
export function normalizePeriod(v: unknown): NavPeriod {
  const t = str(v);
  if (!t) return DEFAULT_NAV_PERIOD;
  const up = t.toUpperCase();
  return (NAV_PERIODS as readonly string[]).includes(up) ? (up as NavPeriod) : DEFAULT_NAV_PERIOD;
}

export interface NavHistoryRow {
  asOfDate: number | null;
  nav: number | null;
  marketPrice: number | null;
}

/** Pull the `item` array out of a price-history series wrapper (`nav`/`marketPrice`: [{item:[…]}]). */
function seriesItems(series: unknown): Record<string, unknown>[] {
  if (!Array.isArray(series) || series.length === 0) return [];
  const item = (series[0] as { item?: unknown } | null | undefined)?.item;
  return Array.isArray(item) ? (item as Record<string, unknown>[]) : [];
}

/** Map a price-history envelope's NAV + market-price series, zipped by date, weight/date filtered. */
export function parseNavHistory(json: unknown): NavHistoryRow[] {
  const env = (json as Record<string, unknown> | null | undefined) ?? {};
  const navItems = seriesItems(env.nav);
  const marketItems = seriesItems(env.marketPrice);
  // Build a date → market price lookup so the two parallel series zip even if lengths differ.
  const marketByDate = new Map<number, number | null>();
  for (const m of marketItems) {
    const d = isoDate(m.asOfDate);
    if (d != null) marketByDate.set(d, num(m.price));
  }
  const rows: NavHistoryRow[] = [];
  for (const n of navItems) {
    const asOfDate = isoDate(n.asOfDate);
    rows.push({
      asOfDate,
      nav: num(n.price),
      marketPrice: asOfDate != null ? marketByDate.get(asOfDate) ?? null : null,
    });
  }
  return rows;
}

export async function fetchNavHistory(
  get: (url: string) => Promise<unknown>,
  fundTicker: string,
  period: NavPeriod = DEFAULT_NAV_PERIOD,
): Promise<NavHistoryRow[]> {
  return parseNavHistory(await get(priceHistoryUrl(fundTicker, period)));
}

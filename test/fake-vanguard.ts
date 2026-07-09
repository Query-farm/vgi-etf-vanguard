// A tiny in-process fake of the Vanguard endpoints — enough to prove the driver: it records
// every requested URL (so a test can assert the wire contract) and returns canned envelopes
// shaped like the real funddetail/all catalog JSON and the per-fund component JSON. No network.
// Matches the driver's injected `get(url) => Promise<unknown>` signature. The fixtures mirror the
// real response shapes observed live (profile / price / portfolio-holding / distribution /
// performance / risk / price-history).

export class FakeVanguard {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly responder: (url: string) => unknown) {}

  get = async (url: string): Promise<unknown> => {
    this.calls.push(url);
    return this.responder(url);
  };

  /** Route by URL: the catalog vs each per-fund component. */
  static router(routes: {
    catalog?: unknown;
    profile?: unknown;
    price?: unknown;
    performance?: unknown;
    risk?: unknown;
    distribution?: unknown;
    holdingsStock?: unknown;
    holdingsBond?: unknown;
    priceHistory?: (period: string) => unknown;
  }): FakeVanguard {
    return new FakeVanguard((url) => {
      if (url.includes("/list/funddetail/")) return routes.catalog ?? {};
      if (url.includes("/price-history/")) {
        const period = url.split("/price-history/")[1] ?? "";
        return routes.priceHistory ? routes.priceHistory(period) : {};
      }
      if (url.includes("/portfolio-holding/stock")) return routes.holdingsStock ?? {};
      if (url.includes("/portfolio-holding/bond")) return routes.holdingsBond ?? {};
      if (url.endsWith("/profile")) return routes.profile ?? {};
      if (url.endsWith("/price")) return routes.price ?? {};
      if (url.endsWith("/performance")) return routes.performance ?? {};
      if (url.endsWith("/risk")) return routes.risk ?? {};
      if (url.endsWith("/distribution")) return routes.distribution ?? {};
      return {};
    });
  }
}

// ── funddetail/all catalog ──────────────────────────────────────────────────────

/** A catalog fund entity (as nested in funddetail/all). */
function catalogEntity(opts: {
  ticker: string;
  fundId: string;
  longName: string;
  shortName: string;
  cusip: string;
  isETF: boolean;
  isBond?: boolean;
  isStock?: boolean;
  expenseRatio: string;
  returns?: Record<string, string>;
}): Record<string, unknown> {
  return {
    type: "priceMonthEndPerformance",
    profile: {
      fundId: opts.fundId,
      ticker: opts.ticker,
      cusip: opts.cusip,
      shortName: opts.shortName,
      longName: opts.longName,
      inceptionDate: "2010-09-07T00:00:00-04:00",
      style: opts.isBond ? "Bond Funds" : "Stock Funds",
      category: opts.isBond ? "Intermediate Core Bond" : "Large Blend",
      customizedStyle: opts.isBond ? "Bond - Long-term Investment" : "Stock - Large-Cap Blend",
      expenseRatio: opts.expenseRatio,
      isETF: opts.isETF,
      isMutualFund: !opts.isETF,
      fundManagementStyle: "Index",
      fundFact: { isStock: opts.isStock ?? !opts.isBond, isBond: opts.isBond ?? false },
    },
    risk: {
      code: opts.isBond ? 2 : 4,
      level: opts.isBond ? "Conservative to Moderate" : "Moderate to Aggressive",
      volatility: { primaryBenchmarkName: opts.isBond ? "Bloomberg US Agg Bond" : "S&P 500 Index" },
    },
    dailyPrice: {
      regular: { asOfDate: "2026-07-08T00:00:00-04:00", price: "685.30" },
      market: { asOfDate: "2026-07-08T00:00:00-04:00", price: "685.26" },
    },
    yield: { asOfDate: "2026-06-30T00:00:00-04:00", yieldPct: "1.03" },
    ytd: { asOfDate: "2026-07-08T00:00:00-04:00", regular: "9.97", marketPrice: "9.94" },
    monthEndAvgAnnualRtn: {
      fundReturn: {
        asOfDate: "2026-06-30T00:00:00-04:00",
        calendarYTDPct: "10.19",
        prevMonthPct: "-0.95",
        threeMonthPct: "15.19",
        oneYrPct: "22.28",
        threeYrPct: "20.58",
        fiveYrPct: "13.36",
        tenYrPct: "15.47",
        sinceInceptionPct: "15.03",
        ...(opts.returns ?? {}),
      },
    },
  };
}

/** A catalog envelope with one ETF (VOO), one bond ETF (BND), and one mutual fund. */
export function catalogEnvelope(): Record<string, unknown> {
  return {
    size: 3,
    self: {},
    fund: {
      entity: [
        catalogEntity({
          ticker: "VOO",
          fundId: "0968",
          longName: "Vanguard S&P 500 ETF",
          shortName: "S&P 500 ETF",
          cusip: "922908363",
          isETF: true,
          expenseRatio: "0.0300",
        }),
        catalogEntity({
          ticker: "BND",
          fundId: "0928",
          longName: "Vanguard Total Bond Market ETF",
          shortName: "Total Bond Market ETF",
          cusip: "921937835",
          isETF: true,
          isBond: true,
          expenseRatio: "0.0300",
        }),
        catalogEntity({
          ticker: "VFIAX",
          fundId: "0540",
          longName: "Vanguard 500 Index Fund Admiral Shares",
          shortName: "500 Index Adm",
          cusip: "922908728",
          isETF: false,
          expenseRatio: "0.0400",
        }),
      ],
    },
  };
}

// ── per-fund components ──────────────────────────────────────────────────────────

/** A stock portfolio-holding envelope with two constituents (one carrying a blank sedol). */
export function stockHoldingsEnvelope(): unknown {
  return {
    size: 2,
    asOfDate: "2026-05-31T00:00:00-04:00",
    fund: {
      entity: [
        {
          type: "portfolioHolding",
          asOfDate: "2026-05-31T00:00:00-04:00",
          longName: "NVIDIA Corp.",
          shortName: "NVIDIA CORP",
          sharesHeld: "636185341",
          marketValue: 134324172898.74,
          ticker: "NVDA",
          isin: "US67066G1040",
          percentWeight: "7.89",
          notionalValue: "0",
          secMainType: "",
          secSubType: "",
          cusip: "67066G104",
          sedol: "2379504",
        },
        {
          type: "portfolioHolding",
          asOfDate: "2026-05-31T00:00:00-04:00",
          longName: "Apple Inc.",
          shortName: "APPLE INC",
          sharesHeld: "201790031",
          marketValue: 62688091030.46,
          ticker: "AAPL",
          isin: "US0378331005",
          percentWeight: "7.06",
          notionalValue: "0",
          secMainType: "",
          secSubType: "",
          cusip: "037833100",
          sedol: "", // blank → null
        },
      ],
    },
  };
}

/** A bond portfolio-holding envelope: same shape plus couponRate / maturityDate / faceAmount. */
export function bondHoldingsEnvelope(): unknown {
  return {
    size: 2,
    asOfDate: "2026-05-31T00:00:00-04:00",
    fund: {
      entity: [
        {
          type: "portfolioHolding",
          asOfDate: "2026-05-31T00:00:00-04:00",
          longName: "Federal National Mortgage Assn.",
          shortName: "Federal National Mortgage Assn.",
          sharesHeld: "0",
          marketValue: 5597572379.98,
          couponRate: "2.000",
          maturityDate: "11/01/2027-06/01/2056",
          faceAmount: "6751682408",
          ticker: "",
          isin: "",
          percentWeight: "1.41",
          notionalValue: "0",
          cusip: "",
          sedol: "",
        },
        {
          type: "portfolioHolding",
          asOfDate: "2026-05-31T00:00:00-04:00",
          longName: "United States Treasury Note",
          shortName: "US TREASURY N/B",
          sharesHeld: "0",
          marketValue: 4200000000.0,
          couponRate: "4.625",
          maturityDate: "02/15/2034",
          faceAmount: "4100000000",
          ticker: "",
          isin: "US91282CJL55",
          percentWeight: "1.05",
          cusip: "91282CJL5",
          sedol: "",
        },
      ],
    },
  };
}

/** A per-fund profile envelope. */
export function profileEnvelope(): unknown {
  return {
    fundProfile: {
      fundId: "0968",
      ticker: "VOO",
      cusip: "922908363",
      shortName: "S&P 500 ETF",
      longName: "Vanguard S&P 500 ETF",
      inceptionDate: "2010-09-07T00:00:00-04:00",
      category: "Large Blend",
      expenseRatio: "0.0300",
      isETF: true,
      fundManagementStyle: "Index",
      fundFact: { isStock: true, isBond: false },
    },
  };
}

/** A per-fund price envelope (currentPrice: premium/discount, yield, daily price, 52-week band). */
export function priceEnvelope(): unknown {
  return {
    currentPrice: {
      premiumOrDiscount: "-0.1500000000",
      yield: { asOfDate: "2026-06-30T00:00:00-04:00", yieldPct: "1.03" },
      dailyPrice: {
        regular: { asOfDate: "2026-07-08T00:00:00-04:00", price: "685.30" },
        market: { asOfDate: "2026-07-08T00:00:00-04:00", price: "685.26" },
      },
      highLow: {
        regular: { highPrice: "698.140000", lowPrice: "571.660000" },
      },
    },
  };
}

/** A per-fund performance envelope (recentInvestmentRtn: fund + benchmark returns). */
export function performanceEnvelope(): unknown {
  return {
    recentInvestmentRtn: {
      benchmarkShortName: "S&P 500 Index",
      fundReturn: {
        calendarYTDPct: "10.19",
        oneYrPct: "22.28",
        threeYrPct: "20.58",
        fiveYrPct: "13.36",
        tenYrPct: "15.47",
        sinceInceptionPct: "15.03",
      },
      benchmarkReturn: { oneYrPct: "22.32" },
    },
  };
}

/** A per-fund risk envelope (level + volatility: benchmark, beta, R-squared). */
export function riskEnvelope(): unknown {
  return {
    code: 4,
    level: "Moderate to Aggressive",
    volatility: {
      primaryBenchmarkName: "S&P 500 Index",
      betaPrimary: "1.00",
      rSquaredPrimary: "1.00",
    },
  };
}

/** A per-fund distribution envelope (divCapGain.item[]). */
export function distributionEnvelope(): unknown {
  return {
    divCapGain: {
      distributionFrequency: "Quarterly",
      item: [
        {
          type: "Dividend",
          perShareAmount: "$1.962200",
          recordDate: "2026-06-26T00:00:00-04:00",
          reinvestmentDate: "2026-06-26T00:00:00-04:00",
          payableDate: "2026-06-30T00:00:00-04:00",
          reinvestPrice: "673.33",
        },
        {
          type: "Dividend",
          perShareAmount: "$1.872400",
          recordDate: "2026-03-27T00:00:00-04:00",
          reinvestmentDate: "2026-03-27T00:00:00-04:00",
          payableDate: "2026-03-31T00:00:00-04:00",
          reinvestPrice: "583.19",
        },
      ],
    },
  };
}

/** A price-history envelope: nav + marketPrice series, each wrapped as [{item:[…]}]. */
export function priceHistoryEnvelope(period = "1Y"): unknown {
  return {
    fundId: "VOO",
    asOfDate: "2026-07-08T00:00:00-04:00",
    isMultiYears: period === "5Y" || period === "10Y",
    dateRange: period,
    nav: [
      {
        item: [
          { asOfDate: "2026-07-07T00:00:00-04:00", price: "687.23" },
          { asOfDate: "2026-07-08T00:00:00-04:00", price: "685.30" },
        ],
      },
    ],
    marketPrice: [
      {
        item: [
          { asOfDate: "2026-07-07T00:00:00-04:00", price: "687.08" },
          { asOfDate: "2026-07-08T00:00:00-04:00", price: "685.26" },
        ],
      },
    ],
  };
}

// A tiny in-process fake of the Vanguard endpoints — enough to prove the driver: it records
// every requested URL (so a test can assert the wire contract) and returns canned envelopes
// shaped like the real funddetail/all catalog JSON and the per-fund irr/funds/profile JSON. No network.
// Matches the driver's injected `get(url) => Promise<unknown>` signature. The fixtures mirror the
// real response shapes observed live (<T>.json / <T>-AdditionalFundData / price-history).

export class FakeVanguard {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly responder: (url: string) => unknown) {}

  get = async (url: string): Promise<unknown> => {
    this.calls.push(url);
    return this.responder(url);
  };

  /** Route by URL: the catalog, the per-fund JSON documents, and price history. */
  static router(routes: {
    catalog?: unknown;
    fundData?: unknown;
    additional?: unknown;
    priceHistory?: (period: string) => unknown;
  }): FakeVanguard {
    return new FakeVanguard((url) => {
      if (url.includes("/list/funddetail/")) return routes.catalog ?? {};
      if (url.includes("/price-history/")) {
        const period = url.split("/price-history/")[1] ?? "";
        return routes.priceHistory ? routes.priceHistory(period) : {};
      }
      if (url.endsWith("-AdditionalFundData")) return routes.additional ?? {};
      if (url.includes("/irr/funds/profile/") && url.endsWith(".json")) return routes.fundData ?? {};
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

// ── per-fund documents (irr/funds/profile plane) ─────────────────────────────────

/** An equity fund's <T>-AdditionalFundData envelope: two stocks, a cash sweep, a future. */
export function stockHoldingsEnvelope(): unknown {
  return {
    historicalPrice: { ticker: "VOO", "1Y": { nav: [{ asOfDate: "10/22/2026", price: "$702.06" }] } },
    holdingDetails: {
      asOfDate: "09/30/2026",
      equityHoldings: [
        {
          securityId: "037833100",
          securityType: "EQ.STOCK",
          securityMainType: "EQ",
          securityLongDescription: "Apple Inc",
          securityShortDescription: "APPLE INC",
          marketValuePercentage: "7.06%",
          ticker: "AAPL",
          isin: "US0378331005",
          cusip: "037833100",
          sedol: "", // blank → null
          shareQuantity: "201,790,031",
          marketValueBaseCurrency: "$62,688,091,030",
          faceAmount: "$201,790,031",
          couponRate: "0.000%",
        },
        {
          securityId: "67066G104",
          securityType: "EQ.STOCK",
          securityMainType: "EQ",
          securityLongDescription: "NVIDIA Corp",
          securityShortDescription: "NVIDIA CORP",
          marketValuePercentage: "8.39%",
          ticker: "NVDA",
          isin: "US67066G1040",
          cusip: "67066G104",
          sedol: "2379504",
          shareQuantity: "635,561,927",
          marketValueBaseCurrency: "$145,149,632,888",
          faceAmount: "$635,561,927",
          couponRate: "0.000%",
        },
      ],
      shortTermReservesHoldings: [
        {
          securityId: "CMT001142",
          securityType: "MM.CASH",
          securityMainType: "MM",
          securityLongDescription: "MKTLIQ",
          securityShortDescription: "MKTLIQ 12/31/2049",
          marketValuePercentage: "0.05%",
          cusip: "CMT001142",
          shareQuantity: "887,152,710",
          marketValueBaseCurrency: "$887,063,995",
          faceAmount: "$887,152,710",
          maturityDate: "12/31/2999",
          couponRate: "5.359%",
        },
      ],
      derivativeHoldings: [
        {
          securityId: "ESZ6",
          securityType: "DE.IND",
          securityMainType: "DE",
          securityLongDescription: "S&P500 EMINI FUT  Dec26",
          securityShortDescription: "S&P500 EMINI FUT  Dec26",
          marketValuePercentage: "0.03%",
          ticker: "ESZ6",
          shareQuantity: "1,486",
          marketValueBaseCurrency: "$573,261,650",
          faceAmount: "$1,486",
        },
      ],
      portfolioCompositionFile: { basketId: "01S990737", usageCode: "CRRD" },
    },
  };
}

/** A bond fund's <T>-AdditionalFundData envelope: fixedIncomeHoldings carry coupon / maturity / face. */
export function bondHoldingsEnvelope(): unknown {
  return {
    holdingDetails: {
      asOfDate: "09/30/2026",
      fixedIncomeHoldings: [
        {
          securityId: "US91282CLW90",
          securityType: "FI.US_GOV",
          securityMainType: "FI",
          securityLongDescription: "United States Treasury Note/Bond",
          securityShortDescription: "US TREASURY N/B",
          marketValuePercentage: "0.41%",
          ticker: "T",
          isin: "US91282CLW90",
          cusip: "91282CLW9",
          sedol: "BRK14Z4",
          shareQuantity: "1,722,038,000",
          marketValueBaseCurrency: "$1,610,912,735",
          faceAmount: "$1,722,038,000",
          maturityDate: "11/15/2034",
          couponRate: "4.250%",
        },
        {
          securityId: "US3140XXXXXX",
          securityType: "FI.MBS",
          securityMainType: "FI",
          securityLongDescription: "Federal National Mortgage Assn.",
          securityShortDescription: "FNMA",
          marketValuePercentage: "0.38%",
          ticker: "",
          isin: "",
          cusip: "",
          sedol: "",
          shareQuantity: "1,600,000,000",
          marketValueBaseCurrency: "$1,500,000,000",
          faceAmount: "$1,600,000,000",
          maturityDate: "06/01/2056",
          couponRate: "2.000%",
        },
      ],
    },
  };
}

/** A whole-fund <T>.json envelope (the slices fund_details and distributions read). */
export function fundDataEnvelope(): unknown {
  return {
    dashboard: {
      fundId: "0968",
      ticker: "VOO",
      fundFullName: "Vanguard S&P 500 ETF",
      managementStyle: "Index",
      category: "Large Blend",
      expenseRatio: "0.03%",
      assetClass: "Domestic Stock - General",
      secYield: "1.00%",
      secYieldAsOfDate: "09/30/2026",
      navPrice: "$702.06",
      navPriceAsOfDate: "10/22/2026",
      marketPrice: "$702.30",
    },
    content: { riskLevel: "4", levelDesc: "Moderate to Aggressive" },
    fundFlags: { isEtf: true, isBond: false, isStock: true, isBalanced: false, isMoneyMarket: false },
    overview: {
      cusip: "922908363",
      managementStyle: "Index",
      assetClass: "Domestic Stock - General",
      category: "Large Blend",
      inceptionDate: "09/07/2010",
      fundId: "0968",
      expenseRatio: "0.03%",
      navPrice: "$702.06",
      navPriceAsOfDate: "10/22/2026",
      marketPrice: "$702.30",
    },
    performancefees: {
      ticker: "VOO",
      fundId: "0968",
      totalReturns: {
        summary: {
          monthEnd: {
            asOfDate: "09/30/2026",
            benchmarkShortName: "S&P 500 Index",
            fundShortName: "S&P 500 ETF",
            fundReturn: {
              calendarYTDPct: "12.72%",
              oneYrPct: "15.70%",
              threeYrPct: "22.85%",
              fiveYrPct: "13.75%",
              tenYrPct: "15.29%",
              sinceInceptionPct: "14.94%",
            },
            benchmarkReturn: { oneYrPct: "15.74%" },
          },
        },
      },
      historicalVolatilityMeasure: {
        volatilityMeasure: [{ benchmarkShortName: "S&P 500 Index", rSquared: "1.00", beta: "1.00" }],
        asOfDate: "09/30/2026",
      },
    },
    price: {
      marketPrice: "$702.30",
      navPrice: "$702.06",
      navPriceAsOfDate: "10/22/2026",
      "52WeekHigh": "$716.11",
      "52WeekLow": "$580.89",
      premiumDiscount: "$0.24",
      premiumDiscountPct: "-0.15%",
      secYield: "1.00%",
      secYieldAsOfDate: "09/30/2026",
    },
    distributions: {
      asOfDate: "09/30/2026",
      distributionSchedule: "Quarterly",
      incomeCapitalGains: [
        {
          type: "Dividend",
          share: "$1.8226000000",
          payableDate: "09/30/2026",
          recordDate: "09/28/2026",
          reInvestDate: "09/28/2026",
          reInvestPrice: "$703.53",
        },
        {
          type: "Dividend",
          share: "$1.9622000000",
          payableDate: "06/30/2026",
          recordDate: "06/26/2026",
          reInvestDate: "06/26/2026",
          reInvestPrice: "$673.33",
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

// Composed example queries — each combines two or more of the worker's own objects (the products
// / holdings tables, the distributions / nav_history functions) in one query a real user would
// write. Each SQL is defined ONCE here and referenced from both the schema-level
// `vgi.example_queries` list (catalog.ts) and the example list of the object that drives it
// (holdings table tags in catalog.ts; the distributions / nav_history functions in functions.ts).
//
// The table functions take literal arguments only (DuckDB rejects a LATERAL column parameter for
// them), so composition is by JOIN / CROSS JOIN / CTE over literal-argument calls.

export interface ExampleQuery {
  description: string;
  sql: string;
}

/** holdings ⋈ products: one stock's weight across several funds, with each fund's name and fee. */
export const NVDA_ACROSS_FUNDS: ExampleQuery = {
  description:
    "NVIDIA's portfolio weight in four Vanguard equity ETFs alongside each fund's name and expense " +
    "ratio (holdings joined to products); a fund that doesn't hold it (the value fund VTV) drops out",
  sql:
    "SELECT h.fund_ticker, p.long_name, p.expense_ratio_percent, h.holding_rank, h.weight_percent " +
    "FROM vanguard.main.holdings h JOIN vanguard.main.products p ON p.ticker = h.fund_ticker " +
    "WHERE h.fund_ticker IN ('VOO', 'VTI', 'VUG', 'VTV') AND h.ticker = 'NVDA' " +
    "ORDER BY h.weight_percent DESC",
};

/** holdings ⋈ holdings: classic two-fund portfolio overlap. */
export const VOO_VUG_OVERLAP: ExampleQuery = {
  description:
    "Portfolio overlap between VOO and VUG: how many constituents they share and the overlapping " +
    "weight (the sum, over shared stocks, of the smaller of the two funds' weights)",
  sql:
    "SELECT count(*) AS shared_holdings, round(sum(least(a.weight_percent, b.weight_percent)), 2) AS overlap_percent " +
    "FROM vanguard.main.holdings a JOIN vanguard.main.holdings b ON a.ticker = b.ticker " +
    "WHERE a.fund_ticker = 'VOO' AND b.fund_ticker = 'VUG' AND a.ticker <> ''",
};

/** distributions × products: trailing-12-month distribution yield vs the published SEC yield. */
export const BND_TRAILING_YIELD: ExampleQuery = {
  description:
    "BND's trailing-12-month distribution yield (per-share distributions over the past year divided " +
    "by the current price from products) next to its published SEC yield",
  sql:
    "SELECT p.ticker, p.price, p.yield_percent AS sec_yield_percent, count(*) AS payouts, " +
    "round(sum(d.per_share_amount), 4) AS paid_per_share, " +
    "round(100 * sum(d.per_share_amount) / p.price, 2) AS trailing_12m_yield_percent " +
    "FROM vanguard.main.distributions('BND', start_date := (CURRENT_DATE - INTERVAL 1 YEAR)::DATE) d " +
    "CROSS JOIN vanguard.main.products p WHERE p.ticker = 'BND' " +
    "GROUP BY p.ticker, p.price, p.yield_percent ORDER BY p.ticker",
};

/** nav_history + distributions: approximate 1-year total return (NAV change + payouts). */
export const VOO_TOTAL_RETURN: ExampleQuery = {
  description:
    "VOO's approximate 1-year total return: the NAV change over the past year plus the " +
    "distributions paid in the same window (payouts not reinvested)",
  sql:
    "WITH nav AS (SELECT arg_min(nav, as_of_date) AS start_nav, arg_max(nav, as_of_date) AS end_nav " +
    "FROM vanguard.main.nav_history('VOO', period := '1Y')), " +
    "paid AS (SELECT sum(per_share_amount) AS per_share " +
    "FROM vanguard.main.distributions('VOO', start_date := (CURRENT_DATE - INTERVAL 1 YEAR)::DATE)) " +
    "SELECT nav.start_nav, nav.end_nav, round(paid.per_share, 4) AS distributions_per_share, " +
    "round(100 * (nav.end_nav / nav.start_nav - 1), 2) AS nav_return_percent, " +
    "round(100 * ((nav.end_nav + paid.per_share) / nav.start_nav - 1), 2) AS total_return_percent " +
    "FROM nav CROSS JOIN paid ORDER BY total_return_percent",
};

/** Serialize an example list for a `vgi.example_queries` tag ({description, sql} per entry). */
export function exampleQueriesTag(examples: readonly ExampleQuery[]): string {
  return JSON.stringify(examples.map(({ description, sql }) => ({ description, sql })));
}

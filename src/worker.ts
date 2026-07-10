// vgi-etf-vanguard stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'vanguard' AS vg (TYPE vgi, LOCATION '/path/to/vgi-etf-vanguard/bin/vgi-etf-vanguard-worker');
//   SELECT * FROM vg.products ORDER BY expense_ratio_percent LIMIT 10;
//   SELECT * FROM vg.holdings WHERE fund_ticker = 'VOO';
//   SELECT * FROM vg.nav_history('VOO', period := '1Y');
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: servedFunctions, catalogInterface }).run();

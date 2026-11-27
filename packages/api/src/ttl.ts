import type { Database } from "bun:sqlite";
import { getSqlite } from "@orc/db/client";
import { ScratchpadStore } from "@orc/db/scratchpads";
import { sweepTtl, type TtlSweep, type TtlSweepOutcome } from "@orc/db/ttl";
import { purgeProject } from "./project-purge.js";

/**
 * Recoverable deletes in ORC. The maintenance loop runs this once a minute; add a
 * resource here after giving its table `archived_at` and `delete_after` and wiring
 * DELETE ?ttl_days / restore in its route.
 */
const sweeps: TtlSweep[] = [
  { resource: "project", table: "projects", labelColumn: "name", purge: purgeProject },
  {
    resource: "scratchpad",
    table: "scratchpads",
    labelColumn: "title",
    purge: (id) => new ScratchpadStore(getSqlite()).purge(id),
  },
];

export function purgeExpiredTtl(sqlite: Database = getSqlite()): TtlSweepOutcome {
  return sweepTtl(sqlite, sweeps);
}

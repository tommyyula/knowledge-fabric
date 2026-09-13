import { rebuildQueryReadinessProjection } from "../server/external/query-readiness";
import { pool } from "../server/db/client";
import { ensureMigrations } from "../server/db/migrations";

try {
  await ensureMigrations();
  const result = await rebuildQueryReadinessProjection();
  console.log(`rebuilt query readiness for ${result.projected} knowledge bases (${result.queryReady} query-ready)`);
} finally {
  await pool?.end();
}

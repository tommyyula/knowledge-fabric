import pg from "pg";
import { env, type DatabaseSslMode } from "../env";

// pg 8.22 / pg-connection-string 2.14 resolve ssl with this precedence:
//   1. ssl params inside the connection string -- these override an explicit `ssl` key
//   2. an explicit `ssl` key on the pool config
//   3. PGSSLMODE -- consulted only when `ssl` is undefined
// Stripping the params out of the url and always passing an explicit `ssl` collapses
// that to one source of truth (DATABASE_SSL), so a stray `?sslmode=` inside a
// deployment secret can no longer silently win.
const SSL_URL_PARAMS = new Set(["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"]);

type EffectiveSslMode = Exclude<DatabaseSslMode, "auto">;

// "auto" tries encrypted first, then plaintext, so a single startup reveals which
// one the server's pg_hba.conf actually accepts.
const ATTEMPT_ORDER: Record<DatabaseSslMode, EffectiveSslMode[]> = {
  auto: ["no-verify", "disable"],
  "no-verify": ["no-verify"],
  require: ["require"],
  disable: ["disable"],
};

interface Attempt {
  mode: EffectiveSslMode;
  error: unknown;
}

function stripSslParams(rawUrl: string): { url: string; removed: string[] } {
  const separator = rawUrl.indexOf("?");
  if (separator < 0) return { url: rawUrl, removed: [] };

  // Edit the query string textually -- rebuilding through `new URL()` would
  // re-encode the credentials in the userinfo section.
  const removed: string[] = [];
  const kept = rawUrl
    .slice(separator + 1)
    .split("&")
    .filter((pair) => {
      if (!pair) return false;
      if (!SSL_URL_PARAMS.has(pair.split("=")[0].toLowerCase())) return true;
      removed.push(pair);
      return false;
    });

  const base = rawUrl.slice(0, separator);
  return { url: kept.length > 0 ? `${base}?${kept.join("&")}` : base, removed };
}

function sslConfigFor(mode: EffectiveSslMode): pg.PoolConfig["ssl"] {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      // `{}` keeps node's tls defaults: full chain plus hostname verification.
      return {};
    case "no-verify":
      return { rejectUnauthorized: false };
  }
}

function describeSsl(mode: EffectiveSslMode): string {
  switch (mode) {
    case "disable":
      return "off (plaintext)";
    case "require":
      return "on (certificate verified)";
    case "no-verify":
      return "on (certificate not verified)";
  }
}

function describeTarget(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const database = parsed.pathname.replace(/^\//, "") || "(default)";
    return `host=${parsed.hostname} port=${parsed.port || "5432"} db=${database} user=${parsed.username || "(unset)"}`;
  } catch {
    return "host=(DATABASE_URL could not be parsed)";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function subnetOf(address: string): string {
  const octets = address.split(".");
  return octets.length === 4 ? `${octets.slice(0, 3).join(".")}.0/24` : address;
}

// Turns the raw driver error into the one thing the operator needs to do next.
// The pg_hba message is the interesting case: it names the *client* address, and
// its trailing "no encryption" / "SSL encryption" says which rule kinds were ruled
// out -- so attempting both modes tells us whether the address or the encryption
// is the blocker.
function diagnose(attempts: Attempt[]): string[] {
  const text = attempts.map((attempt) => messageOf(attempt.error)).join(" | ");
  const codes = new Set(attempts.map((attempt) => (attempt.error as { code?: string } | null)?.code));
  const clientAddress = /no pg_hba\.conf entry for host "([^"]+)"/.exec(text)?.[1];

  if (clientAddress) {
    const lines = [
      `authentication was refused: pg_hba.conf has no rule matching client address ${clientAddress}`,
      `that address is this container's source address as the server sees it, not the address of the server itself`,
    ];
    const triedEncrypted = /SSL encryption/.test(text);
    const triedPlaintext = /no encryption/.test(text);
    const serverRefusedSsl = /does not support SSL/i.test(text);

    if ((triedEncrypted && triedPlaintext) || (triedPlaintext && serverRefusedSsl)) {
      lines.push(`encrypted and plaintext were both refused, so the address is the blocker and no DATABASE_SSL value will help`);
      lines.push(`ask the dba to allow ${subnetOf(clientAddress)} for user/database above, then have them run: select pg_reload_conf()`);
    } else if (triedPlaintext) {
      lines.push(`only plaintext was attempted -- set DATABASE_SSL=auto to also probe an encrypted connection, which distinguishes a hostssl rule from a missing address`);
    } else {
      lines.push(`only encrypted was attempted -- set DATABASE_SSL=auto to also probe plaintext, which distinguishes a host rule from a missing address`);
    }
    return lines;
  }

  if (codes.has("28P01")) return ["the address was allowed but the password was rejected -- check the credentials in DATABASE_URL"];
  if (codes.has("3D000")) return ["the address was allowed but the database named in DATABASE_URL does not exist"];
  if (/self.signed|unable to verify|certificate/i.test(text)) {
    return ["the server's certificate is not trusted -- use DATABASE_SSL=no-verify, or DATABASE_SSL=require once the ca is installed"];
  }
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN/.test(text)) {
    return ["the server was never reached -- this is a network, dns or firewall problem rather than an authentication one"];
  }
  return [];
}

const connection = env.databaseUrl ? stripSslParams(env.databaseUrl) : null;
const attemptOrder = ATTEMPT_ORDER[env.databaseSsl];

if (connection && connection.removed.length > 0) {
  console.warn(`[db] ignoring ssl params in DATABASE_URL, DATABASE_SSL is authoritative: ${connection.removed.join(" ")}`);
}
if (process.env.PGSSLMODE) {
  console.warn(`[db] ignoring PGSSLMODE=${process.env.PGSSLMODE}, DATABASE_SSL is authoritative`);
}
if (process.env.DATABASE_SSL && process.env.DATABASE_SSL.trim().toLowerCase() !== env.databaseSsl) {
  console.warn(`[db] unrecognized DATABASE_SSL=${process.env.DATABASE_SSL}, falling back to "${env.databaseSsl}"`);
}

function createPool(url: string, mode: EffectiveSslMode): pg.Pool {
  return new pg.Pool({ connectionString: url, ssl: sslConfigFor(mode) });
}

export let pool: pg.Pool | null = connection ? createPool(connection.url, attemptOrder[0]) : null;

/**
 * Verifies the database is actually reachable before the rest of the process
 * depends on it, and reports the ssl mode that worked. With DATABASE_SSL=auto the
 * pool is rebuilt on the fallback mode, so the exported `pool` always points at a
 * configuration that has completed a round trip.
 */
export async function preflightDatabase(): Promise<void> {
  if (!connection || !pool) {
    console.warn("[db] DATABASE_URL is not configured, falling back to in-memory storage");
    return;
  }

  const target = describeTarget(connection.url);
  const failed: Attempt[] = [];
  let active = pool;

  for (const [index, mode] of attemptOrder.entries()) {
    if (index > 0) {
      await active.end().catch(() => {});
      active = createPool(connection.url, mode);
      pool = active;
    }
    try {
      await active.query("select 1");
      console.log(`[db] connected ${target} ssl=${describeSsl(mode)} (DATABASE_SSL=${env.databaseSsl})`);
      return;
    } catch (error) {
      failed.push({ mode, error });
      console.warn(`[db] connect failed ${target} ssl=${describeSsl(mode)}: ${messageOf(error)}`);
    }
  }

  for (const line of diagnose(failed)) console.error(`[db] ${line}`);
  throw failed[failed.length - 1].error;
}

export async function query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool.query(text, params) as unknown as Promise<{ rows: T[] }>;
}

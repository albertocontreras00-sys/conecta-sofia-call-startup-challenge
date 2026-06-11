// db/neon.js - Database connection singleton with error tracking
import crypto from "crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import WebSocket from "ws";
import dotenv from "dotenv";
import path from "path";
import { getRequestContext } from "../utils/requestContextStore.js";
import { logInfo, logWarn, logError } from "../utils/logger.js";

neonConfig.webSocketConstructor = WebSocket;
neonConfig.forceWebSocket = true;
neonConfig.useSecureWebSocket = true;
neonConfig.pipelineTLS = true;

let normalizedDatabaseUrl = null;
let sqlPool = null;
let envBootstrapped = false;
const SLOW_QUERY_WARN_MS = Number(process.env.DB_SLOW_QUERY_WARN_MS || 500);
const SLOW_QUERY_HIGH_MS = Number(process.env.DB_SLOW_QUERY_HIGH_MS || 1500);
const SLOW_QUERY_CRITICAL_MS = Number(process.env.DB_SLOW_QUERY_CRITICAL_MS || 3000);

function ensureEnvForDatabase() {
  if (envBootstrapped) return;
  envBootstrapped = true;
  if (process.env.DATABASE_URL) return;
  if (process.env.NODE_ENV === "production") return;

  const envPath = path.resolve(process.cwd(), ".env");
  dotenv.config({
    path: envPath,
    override: true,
  });
}

function normalizeDatabaseUrl(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);
    parsedUrl.searchParams.set("pooler", "session");
    const sslmode = parsedUrl.searchParams.get("sslmode");
    if (!sslmode || sslmode.toLowerCase() !== "require") {
      parsedUrl.searchParams.set("sslmode", "require");
    }
    return parsedUrl.toString();
  } catch (error) {
    throw new Error(`Invalid DATABASE_URL format: ${error.message}`);
  }
}

const KNOWN_PROD_DB_HOSTS = ['ep-holy-dew-af37snsi-pooler'];

function getNormalizedDatabaseUrl() {
  ensureEnvForDatabase();
  if (!normalizedDatabaseUrl) {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase();
    if ((nodeEnv === 'development' || nodeEnv === 'local') && !process.env.ALLOW_DEV_PROD_DB) {
      const isProdHost = KNOWN_PROD_DB_HOSTS.some(host => rawUrl.includes(host));
      if (isProdHost) {
        throw new Error(
          'DATABASE_URL appears to point at a production Neon database while NODE_ENV=development. ' +
          'Use a dedicated dev/staging database, or set ALLOW_DEV_PROD_DB=true to override this safety guard.'
        );
      }
    }

    normalizedDatabaseUrl = normalizeDatabaseUrl(rawUrl);
  }

  return normalizedDatabaseUrl;
}

function normalizeQueryArgs(args = []) {
  if (!args || args.length === 0) return args;
  const [first, ...rest] = args;

  // Tagged template usage: sql`SELECT * FROM t WHERE id = ${id}`
  if (Array.isArray(first) && first.raw) {
    const text = first.reduce((acc, segment, idx) => {
      if (idx === 0) return segment;
      return `${acc}$${idx}${segment}`;
    }, "");
    return [text, rest];
  }

  return args;
}

function isQueryOptions(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && (
    typeof value.label === "string" ||
    typeof value.operation === "string" ||
    typeof value.backgroundJobName === "string" ||
    typeof value.transaction === "boolean"
  );
}

function extractQueryOptions(args = []) {
  if (!args.length) return { args, options: {} };
  const last = args[args.length - 1];
  if (!isQueryOptions(last)) {
    return { args, options: {} };
  }
  return {
    args: args.slice(0, -1),
    options: last
  };
}

function normalizeOperationLabel(value, fallback = "sql.query") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function createSqlTraceContext() {
  const requestContext = getRequestContext?.() || null;
  const requestId = requestContext?.requestId || null;
  const orgId = requestContext?.orgId || requestContext?.userData?.org_id || null;
  const userId = requestContext?.userId || requestContext?.user?.uid || null;
  const route = requestContext?.path || requestContext?.url || null;
  const routeName = requestContext?.route_name || null;
  const operationName = requestContext?.operation_name || null;
  const backgroundJobName = requestContext?.background_job_name || null;
  const webhookName = requestContext?.webhook_name || null;
  const contextType = requestContext?.context_type || null;
  const testRunId = requestContext?.testRunId || null;
  const candidateId = requestContext?.candidateId || null;
  const testMode = requestContext?.testMode || null;
  const workflow = requestContext?.workflow || null;
  const isCrashLabRequest = requestContext?.isCrashLabRequest === true;

  return {
    trace_id: requestId || crypto.randomUUID(),
    requestId,
    request_id: requestId,
    orgId,
    org_id: orgId,
    userId,
    user_id: userId,
    route,
    route_name: routeName,
    method: requestContext?.method || null,
    operation_name: operationName,
    background_job_name: backgroundJobName,
    webhook_name: webhookName,
    context_type: contextType,
    testRunId,
    candidateId,
    testMode,
    workflow,
    isCrashLabRequest,
  };
}

function createSpan(parent = {}, name = "sql_query") {
  const span = {
    span_id: crypto.randomUUID(),
  };
  if (parent?.trace_id) span.trace_id = parent.trace_id;
  if (name) span.name = name;
  return span;
}

function timeSpan() {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
}

function getContextMetadata(trace = {}, options = {}) {
  const orgId = trace.orgId || trace.org_id || null;
  const userId = trace.userId || trace.user_id || null;
  const route = trace.route || trace.path || null;
  const routeName = trace.route_name || null;
  const requestId = trace.requestId || trace.request_id || null;
  const operationName = trace.operation_name || null;
  const backgroundJobName = options.backgroundJobName || trace.background_job_name || null;
  const webhookName = trace.webhook_name || null;
  const contextType = trace.context_type || null;
  const testRunId = trace.testRunId || null;
  const candidateId = trace.candidateId || null;
  const testMode = trace.testMode || null;
  const workflow = trace.workflow || null;
  const isCrashLabRequest = trace.isCrashLabRequest === true;
  const hasRequestContext = Boolean(
    trace?.trace_id ||
    route ||
    routeName ||
    requestId ||
    orgId ||
    userId ||
    operationName ||
    backgroundJobName ||
    webhookName ||
    contextType ||
    testRunId ||
    candidateId ||
    testMode ||
    workflow
  );

  return {
    orgId,
    userId,
    route,
    routeName,
    requestId,
    operationName,
    backgroundJobName,
    webhookName,
    testRunId,
    candidateId,
    testMode,
    workflow,
    isCrashLabRequest,
    hasRequestContext,
    contextType: contextType || (hasRequestContext ? "request" : "background")
  };
}

function getSlowQuerySeverity(durationMs) {
  if (durationMs >= SLOW_QUERY_CRITICAL_MS) return "error";
  if (durationMs >= SLOW_QUERY_HIGH_MS) return "warn";
  if (durationMs >= SLOW_QUERY_WARN_MS) return "info";
  return null;
}

function shouldEmitBackgroundSqlStart(contextMeta = {}) {
  return contextMeta.contextType !== "background";
}

function shouldSuppressBackgroundSqlEnd(contextMeta = {}, rowCount, durationMs, slowSeverity) {
  if (contextMeta.contextType !== "background") return false;
  if (slowSeverity) return false;
  if (typeof rowCount !== "number") return false;
  if (rowCount !== 0) return false;
  return durationMs < SLOW_QUERY_WARN_MS;
}

function createSqlClient() {
  return new Pool({
    connectionString: getNormalizedDatabaseUrl(),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 10000),
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 10000),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  });
}

function getTestDatabaseSchema() {
  const schema = process.env.TEST_DATABASE_SCHEMA?.trim();
  if (!schema) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid TEST_DATABASE_SCHEMA: ${schema}`);
  }
  return schema;
}

// Get or initialize the SQL pool instance
function getSqlInstance() {
  if (!sqlPool) {
    sqlPool = createSqlClient();
  }
  return sqlPool;
}

export { getSqlInstance, getNormalizedDatabaseUrl, createSqlClient };

export async function closeSqlInstance() {
  if (sqlPool) {
    await sqlPool.end();
    sqlPool = null;
  }
  normalizedDatabaseUrl = null;
  envBootstrapped = false;
}

async function notifySqlError(context, error, meta = {}) {
  // Get user context from AsyncLocalStorage if available
  let userContext = null;
  let currentRequestContext = null;
  try {
    const { getRequestContext, getCurrentUserId, getCurrentUserEmail, getCurrentOrgId } = await import("../utils/requestContextStore.js");
    currentRequestContext = getRequestContext();
    if (currentRequestContext) {
      userContext = {
        userId: getCurrentUserId(),
        userEmail: getCurrentUserEmail(),
        orgId: getCurrentOrgId(),
        url: currentRequestContext.url,
        method: currentRequestContext.method,
        requestId: currentRequestContext.requestId
      };
    }
  } catch (_importError) {
    // Request context is optional.
  }

  // Merge user context into meta
  const enrichedMeta = {
    ...meta,
    ...(userContext ? {
      userId: userContext.userId,
      userEmail: userContext.userEmail,
      orgId: userContext.orgId || meta?.orgId || meta?.org_id || null,
      url: userContext.url,
      method: userContext.method,
      requestId: userContext.requestId,
      testRunId: currentRequestContext?.testRunId || null,
      candidateId: currentRequestContext?.candidateId || null,
      testMode: currentRequestContext?.testMode || null,
      workflow: currentRequestContext?.workflow || null,
      isCrashLabRequest: currentRequestContext?.isCrashLabRequest === true
    } : {})
  };

  logError('neon.js', `Database error in ${context}`, error, {
    route: 'database',
    method: context,
    org_id: enrichedMeta.orgId || null,
    user_id: enrichedMeta.userId || null,
    query_fingerprint: enrichedMeta.query_fingerprint || meta?.query_fingerprint || 'unknown',
    query_operation: enrichedMeta.query_operation || meta?.query_operation || 'unknown',
    queryType: enrichedMeta.type || meta?.type || 'unknown',
    testRunId: enrichedMeta.testRunId || null,
    candidateId: enrichedMeta.candidateId || null,
    testMode: enrichedMeta.testMode || null,
    workflow: enrichedMeta.workflow || null,
    isCrashLabRequest: enrichedMeta.isCrashLabRequest === true,
  });
}

function buildSqlLogPayload({
  trace,
  span,
  operation,
  contextMeta,
  queryOperation,
  queryFingerprint,
  durationMs = null,
  rowCount = null,
  inTransaction = false,
}) {
  return {
    ...trace,
    ...span,
    operation,
    operation_name: contextMeta.operationName,
    query_operation: queryOperation,
    query_fingerprint: queryFingerprint,
    ...(durationMs === null ? {} : { duration_ms: durationMs }),
    ...(rowCount === null ? {} : { rowCount }),
    orgId: contextMeta.orgId,
    userId: contextMeta.userId,
    route: contextMeta.route,
    route_name: contextMeta.routeName,
    requestId: contextMeta.requestId,
    testRunId: contextMeta.testRunId,
    candidateId: contextMeta.candidateId,
    testMode: contextMeta.testMode,
    workflow: contextMeta.workflow,
    isCrashLabRequest: contextMeta.isCrashLabRequest,
    has_request_context: contextMeta.hasRequestContext,
    context_type: contextMeta.contextType,
    background_job_name: contextMeta.backgroundJobName,
    webhook_name: contextMeta.webhookName,
    in_transaction: inTransaction,
    context_missing: !contextMeta.hasRequestContext,
  };
}

function emitSqlCompletionLog(result, payload, durationMs) {
  const rows = Array.isArray(result) ? result.length : Array.isArray(result?.rows) ? result.rows.length : null;
  const logPayload = {
    ...payload,
    duration_ms: durationMs,
    rowCount: rows,
  };
  const slowSeverity = getSlowQuerySeverity(durationMs);
  const slowQuery = Boolean(slowSeverity);
  const suppressEnd = shouldSuppressBackgroundSqlEnd(
    { contextType: payload.context_type },
    rows,
    durationMs,
    slowSeverity
  );

  if (slowSeverity) {
    if (slowSeverity === "error") {
      logError("neon.sql", "proxy_sql_slow", null, {
        ...logPayload,
        slowQuery,
        event_key: "db.slowQuery",
      });
    } else if (slowSeverity === "warn") {
      logWarn("neon.sql", "proxy_sql_slow", {
        ...logPayload,
        slowQuery,
        event_key: "db.slowQuery",
      });
    } else {
      logInfo("neon.sql", "proxy_sql_slow", {
        ...logPayload,
        slowQuery,
        event_key: "db.slowQuery",
      });
    }
  }

  if (!suppressEnd) {
    logInfo("neon.sql", "proxy_sql_end", {
      ...logPayload,
      slowQuery,
      event_key: "db.query",
    });
  }
}

// Enhanced SQL function with error tracking + tracing
export const sql = async (...args) => {
  let pool;
  const trace = createSqlTraceContext();
  const span = createSpan(trace, "sql_query");
  const duration = timeSpan();
  const { args: queryArgs, options } = extractQueryOptions(args);
  const operation = normalizeOperationLabel(options.label || options.operation, `sql.${getOperationFromQuery(getQueryPreviewFromArgs(queryArgs)).toLowerCase()}`);
  const contextMeta = getContextMetadata(trace, options);
  const inTransaction = options.transaction === true;
  try {
    pool = getSqlInstance();
  } catch (connectionError) {
    await handleSqlError("connection_init", connectionError, "connection_initialization", []);
    throw connectionError;
  }
  
  const queryPreview = getQueryPreviewFromArgs(queryArgs);
  const queryOperation = getOperationFromQuery(queryPreview);
  const queryFingerprint = getQueryFingerprint(queryPreview);
  if (shouldEmitBackgroundSqlStart(contextMeta)) {
    logInfo("neon.sql", "proxy_sql_start", {
      ...trace,
      ...span,
      operation,
      operation_name: contextMeta.operationName,
      query_operation: queryOperation,
      query_fingerprint: queryFingerprint,
      orgId: contextMeta.orgId,
      userId: contextMeta.userId,
      route: contextMeta.route,
      route_name: contextMeta.routeName,
      requestId: contextMeta.requestId,
      has_request_context: contextMeta.hasRequestContext,
      context_type: contextMeta.contextType,
      background_job_name: contextMeta.backgroundJobName,
      webhook_name: contextMeta.webhookName,
      in_transaction: inTransaction,
      context_missing: !contextMeta.hasRequestContext,
      event_key: "db.query",
    });
  }

  const execute = async () => {
    try {
      // Pool handles queries similarly to the neon() function for template literals
      const normalizedArgs = normalizeQueryArgs(queryArgs);
      const testSchema = getTestDatabaseSchema();

      if (testSchema) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL search_path TO "${testSchema}", public`);
          const result = await client.query(...normalizedArgs);
          await client.query("COMMIT");
          if (!result) {
            return [];
          }
          return result.rows || result;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Ignore rollback errors and surface the original query error.
          }
          throw error;
        } finally {
          client.release();
        }
      }

      const result = await pool.query(...normalizedArgs);
      // For consistency with the rest of the app which expects rows directly
      if (!result) {
        return [];
      }
      return result.rows || result;
    } catch (error) {
      const isConnectionError = error.message?.includes('connection') || 
                               error.message?.includes('ECONNREFUSED') ||
                               error.message?.includes('ENOTFOUND') ||
                               error.message?.includes('ETIMEDOUT') ||
                               error.message?.includes('timeout') ||
                               error.code === 'ECONNREFUSED' ||
                               error.code === 'ENOTFOUND' ||
                               error.code === 'ETIMEDOUT';
      
      const errorContext = isConnectionError ? "connection_error" : "query_error";
      logError("neon.sql", "proxy_sql_error", error, {
        ...trace,
        ...span,
        operation,
        operation_name: contextMeta.operationName,
        query_operation: queryOperation,
        query_fingerprint: queryFingerprint,
        duration_ms: duration(),
        orgId: contextMeta.orgId,
        userId: contextMeta.userId,
        route: contextMeta.route,
        route_name: contextMeta.routeName,
        requestId: contextMeta.requestId,
        has_request_context: contextMeta.hasRequestContext,
        context_type: contextMeta.contextType,
        background_job_name: contextMeta.backgroundJobName,
        webhook_name: contextMeta.webhookName,
        in_transaction: inTransaction,
        event_key: "db.query",
      });
      await handleSqlError(errorContext, error, queryPreview, queryArgs.slice(1));
      throw error;
    }
  };

  const logQueryCompletion = (result) => {
    const rows = Array.isArray(result) ? result.length : Array.isArray(result?.rows) ? result.rows.length : null;
    const durationMs = duration();
    const logPayload = buildSqlLogPayload({
      trace,
      span,
      operation,
      contextMeta,
      queryOperation,
      queryFingerprint,
      durationMs,
      rowCount: rows,
      inTransaction,
    });

    const slowSeverity = getSlowQuerySeverity(durationMs);
    const slowQuery = Boolean(slowSeverity);
    const suppressEnd = shouldSuppressBackgroundSqlEnd(contextMeta, rows, durationMs, slowSeverity);
    if (slowSeverity) {
      if (slowSeverity === "error") {
        logError("neon.sql", "proxy_sql_slow", null, {
          ...logPayload,
          slowQuery,
          event_key: "db.slowQuery",
        });
      } else if (slowSeverity === "warn") {
        logWarn("neon.sql", "proxy_sql_slow", {
          ...logPayload,
          slowQuery,
          event_key: "db.slowQuery",
        });
      } else {
        logInfo("neon.sql", "proxy_sql_slow", {
          ...logPayload,
          slowQuery,
          event_key: "db.slowQuery",
        });
      }
    }

    if (!suppressEnd) {
      logInfo("neon.sql", "proxy_sql_end", {
        ...logPayload,
        slowQuery,
        event_key: "db.query",
      });
    }
    return result;
  };

  const result = await execute();
  return logQueryCompletion(result);
};

async function handleSqlError(context, error, query, args = []) {
  const preview = query?.substring ? query.substring(0, 200) : query;
  const queryOperation = getOperationFromQuery(preview || "");
  const queryFingerprint = getQueryFingerprint(preview || "");
  await notifySqlError(context, error, {
    type: "database_query",
    query_operation: queryOperation,
    query_fingerprint: queryFingerprint,
    args_count: Array.isArray(args) ? args.length : 0
  });
}

function getQueryPreviewFromArgs(args) {
  if (!args || args.length === 0) return "unknown_query";
  const [first] = args;

  if (typeof first === "string") {
    return first.substring(0, 200);
  }

  if (Array.isArray(first) && first.raw) {
    return first.join("{{param}}").substring(0, 200);
  }

  return "template_literal_query";
}

function normalizeQueryForFingerprint(query = "") {
  return String(query)
    .replace(/\$\d+/g, "{{param}}")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getQueryFingerprint(query = "") {
  const normalized = normalizeQueryForFingerprint(query);
  if (!normalized) return "unknown_query";
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function getOperationFromQuery(query = "") {
  const match = query.trim().match(/^[a-zA-Z]+/);
  return match ? match[0].toUpperCase() : "UNKNOWN";
}

function traceHelper(_queryText, fn) {
  return fn();
}

/**
 * Enhanced transaction support using Pool clients.
 * sql.begin(async (tx) => { ... })
 */
sql.begin = async (callback) => {
  if (typeof callback !== "function") {
    throw new Error('sql.begin requires an async callback function');
  }

  const pool = getSqlInstance();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Create a transaction-scoped query helper
    const tx = async (...args) => {
      const normalizedArgs = normalizeQueryArgs(args);
      const result = await client.query(...normalizedArgs);
      return result.rows || result;
    };
    
    // Add helpers to tx if needed (single, first, etc.)
    tx.query = (q, p) => client.query(q, p);

    const result = await callback(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

function attachHelper(name, { isAsync = false, context = name } = {}) {
  // Only skip if already defined (like sql.begin)
  if (sql[name]) return;

  Object.defineProperty(sql, name, {
    configurable: true,
    enumerable: false,
    value: (...helperArgs) => {
      const pool = getSqlInstance();
      // Most helpers don't exist on Pool directly in @neondatabase/serverless
      // We might need to handle them or let them fail if not used
      
      if (!isAsync) {
        // Fallback for non-async helpers like sql.array
        if (name === "array") {
          const [arrayValue] = helperArgs;
          return arrayValue;
        }
        throw new Error(`Neon SQL helper "${name}" is not available on the pool`);
      }

      return (async () => {
        try {
          const normalizedArgs = normalizeQueryArgs(helperArgs);
          const result = await pool.query(...normalizedArgs);
          const rows = result.rows || result;
          if (name === "single" || name === "first") {
            return rows[0];
          }
          return rows;
        } catch (error) {
          await notifySqlError(context, error, { helper: name });
          throw error;
        }
      })();
    }
  });
}

attachHelper("raw");
attachHelper("array", { isAsync: false });
attachHelper("single", { isAsync: true });
attachHelper("first", { isAsync: true });

Object.defineProperty(sql, "unsafe", {
  configurable: true,
  enumerable: false,
  value: (queryText) => {
    // Basic fallback for unsafe
    return queryText;
  }
});

// Expose sql.query for parameterized queries ($1, $2 placeholders)
sql.query = async (queryText, params = []) => {
  let pool;
  const trace = createSqlTraceContext();
  const span = createSpan(trace, "sql_query");
  const duration = timeSpan();
  const queryPreview = typeof queryText === "string" ? queryText.substring(0, 200) : "unknown_query";
  const queryOperation = getOperationFromQuery(queryPreview);
  const queryFingerprint = getQueryFingerprint(queryPreview);
  const operation = `sql.${queryOperation.toLowerCase()}`;
  const contextMeta = getContextMetadata(trace, {});
  try {
    pool = getSqlInstance();
  } catch (connectionError) {
    await handleSqlError("connection_init", connectionError, "connection_initialization", []);
    throw connectionError;
  }

  const baseLogPayload = buildSqlLogPayload({
    trace,
    span,
    operation,
    contextMeta,
    queryOperation,
    queryFingerprint,
  });

  if (shouldEmitBackgroundSqlStart(contextMeta)) {
    logInfo("neon.sql", "proxy_sql_start", {
      ...baseLogPayload,
      event_key: "db.query",
    });
  }

  const exec = async () => {
    try {
      const result = await pool.query(queryText, params);
      emitSqlCompletionLog(result, baseLogPayload, duration());
      return result;
    } catch (error) {
      const isConnectionError = error.message?.includes('connection') ||
                               error.message?.includes('ECONNREFUSED') ||
                               error.message?.includes('ENOTFOUND') ||
                               error.message?.includes('ETIMEDOUT') ||
                               error.message?.includes('timeout') ||
                               error.code === 'ECONNREFUSED' ||
                               error.code === 'ENOTFOUND' ||
                               error.code === 'ETIMEDOUT';

      const errorContext = isConnectionError ? "connection_error" : "query_error";
      logError("neon.sql", "proxy_sql_error", error, {
        ...baseLogPayload,
        duration_ms: duration(),
        params_count: Array.isArray(params) ? params.length : 0,
        event_key: "db.query",
      });
      await handleSqlError(errorContext, error, queryText, params);
      throw error;
    }
  };
  return traceHelper(queryText, exec);
};

// Export raw query function for dynamic queries
export async function rawQuery(queryText, params = []) {
  const result = await sql.query(queryText, params);

  // Compatibility contract: rawQuery should return rows array.
  // Some drivers return a pg Result object ({ rows, rowCount, ... }).
  if (Array.isArray(result)) {
    return result;
  }

  if (Array.isArray(result?.rows)) {
    return result.rows;
  }

  return [];
}


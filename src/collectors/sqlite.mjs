import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { displayPath } from "../config.mjs";
import { toFiniteNumber } from "../utils.mjs";

function versionFromName(name, prefix) {
  const match = name.match(new RegExp(`^${prefix}(?:_(\\d+))?\\.sqlite$`));
  return match ? Number(match[1] || 0) : -1;
}

const REQUIRED_COLUMNS = {
  state: {
    table: "threads",
    columns: [
      "id", "rollout_path", "created_at", "updated_at", "created_at_ms", "updated_at_ms",
      "recency_at_ms", "source", "thread_source", "model_provider", "model", "reasoning_effort",
      "cwd", "tokens_used", "archived", "is_pinned", "cli_version", "agent_nickname", "agent_role",
    ],
  },
  logs: { table: "logs", columns: ["ts", "level", "target"] },
  goals: { table: "thread_goals", columns: ["tokens_used", "time_used_seconds"] },
};

function hasCompatibleSchema(databasePath, prefix) {
  const requirement = REQUIRED_COLUMNS[prefix];
  if (!requirement) return true;
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 250 });
    database.exec("PRAGMA query_only = ON");
    const columns = new Set(database.prepare(`PRAGMA table_info(${requirement.table})`).all().map((row) => row.name));
    return requirement.columns.every((column) => columns.has(column));
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export async function findVersionedDatabase(directory, prefix) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches = entries
    .filter((entry) => entry.isFile() && versionFromName(entry.name, prefix) >= 0)
    .sort((left, right) => versionFromName(right.name, prefix) - versionFromName(left.name, prefix));
  for (const match of matches) {
    const databasePath = path.join(directory, match.name);
    if (hasCompatibleSchema(databasePath, prefix)) return databasePath;
  }
  return null;
}

export function withReadonlyDatabase(databasePath, callback) {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 250,
  });
  let transactionStarted = false;
  try {
    database.exec("PRAGMA query_only = ON");
    database.exec("BEGIN DEFERRED");
    transactionStarted = true;
    return callback(database);
  } finally {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Closing the read-only connection still releases any read snapshot.
      }
    }
    database.close();
  }
}

function timestampMs(seconds, milliseconds) {
  return toFiniteNumber(milliseconds) || toFiniteNumber(seconds) * 1_000;
}

function localDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function publicThread(row) {
  return {
    id: row.id,
    createdAt: timestampMs(row.created_at, row.created_at_ms),
    updatedAt: timestampMs(row.updated_at, row.updated_at_ms),
    source: row.thread_source || row.source || "unknown",
    modelProvider: row.model_provider || "unknown",
    model: row.model || row.model_provider || "unknown",
    reasoningEffort: row.reasoning_effort || null,
    cwd: displayPath(row.cwd),
    tokens: toFiniteNumber(row.tokens_used),
    archived: Boolean(row.archived),
    pinned: Boolean(row.is_pinned),
    cliVersion: row.cli_version || null,
    agentNickname: row.agent_nickname || null,
    agentRole: row.agent_role || null,
    spanMs: Math.max(
      0,
      timestampMs(row.updated_at, row.updated_at_ms) - timestampMs(row.created_at, row.created_at_ms),
    ),
  };
}

const PUBLIC_THREAD_COLUMNS = `
  id, created_at, updated_at, created_at_ms, updated_at_ms,
  source, thread_source, model_provider, model, reasoning_effort,
  cwd, tokens_used, archived, is_pinned, cli_version,
  agent_nickname, agent_role
`;

export function queryThreadOverview(database, { recentLimit = 20, now = Date.now() } = {}) {
  const recentCutoff = Math.floor(now / 1_000) - 15 * 60;
  const statsRow = database.prepare(`
    SELECT
      COUNT(*) AS threads,
      SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS current_threads,
      SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived_threads,
      SUM(CASE WHEN archived = 0 AND updated_at >= ? THEN 1 ELSE 0 END) AS active_threads,
      SUM(tokens_used) AS total_tokens
    FROM threads
  `).get(recentCutoff);

  const byModel = database.prepare(`
    SELECT
      COALESCE(NULLIF(model, ''), NULLIF(model_provider, ''), 'unknown') AS key,
      COUNT(*) AS threads,
      SUM(tokens_used) AS tokens
    FROM threads
    GROUP BY key
    ORDER BY tokens DESC
    LIMIT 12
  `).all().map((row) => ({
    key: row.key,
    threads: toFiniteNumber(row.threads),
    tokens: toFiniteNumber(row.tokens),
  }));

  const byModelReasoning = database.prepare(`
    SELECT
      COALESCE(NULLIF(model, ''), NULLIF(model_provider, ''), 'unknown') AS key,
      COALESCE(NULLIF(TRIM(reasoning_effort), ''), 'unknown') AS effort_key,
      COUNT(*) AS threads,
      SUM(tokens_used) AS tokens
    FROM threads
    GROUP BY key, effort_key
    ORDER BY tokens DESC
    LIMIT 96
  `).all().map((row) => ({
    key: row.key,
    reasoningEffort: row.effort_key,
    threads: toFiniteNumber(row.threads),
    tokens: toFiniteNumber(row.tokens),
  }));

  const rawDaily = database.prepare(`
    SELECT
      date(created_at, 'unixepoch', 'localtime') AS date,
      COUNT(*) AS threads,
      SUM(tokens_used) AS tokens
    FROM threads
    WHERE created_at >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(Math.floor(now / 1_000) - 13 * 86_400);

  const recentRows = database.prepare(`
    SELECT ${PUBLIC_THREAD_COLUMNS}, rollout_path
    FROM threads
    ORDER BY recency_at_ms DESC, updated_at_ms DESC, id DESC
    LIMIT ${Math.max(1, Math.min(100, Number(recentLimit) || 20))}
  `).all();

  return {
    stats: {
      threads: toFiniteNumber(statsRow.threads),
      currentThreads: toFiniteNumber(statsRow.current_threads),
      archivedThreads: toFiniteNumber(statsRow.archived_threads),
      activeThreads: toFiniteNumber(statsRow.active_threads),
      totalTokens: toFiniteNumber(statsRow.total_tokens),
    },
    byModel,
    byModelReasoning,
    recentDaily: (() => {
      const observed = new Map(rawDaily.map((row) => [row.date, row]));
      return Array.from({ length: 14 }, (_unused, index) => {
        const day = new Date(now);
        day.setHours(12, 0, 0, 0);
        day.setDate(day.getDate() - (13 - index));
        const date = localDateKey(day);
        const row = observed.get(date);
        return {
          date,
          threads: toFiniteNumber(row?.threads),
          tokens: toFiniteNumber(row?.tokens),
        };
      });
    })(),
    recentThreads: recentRows.map(publicThread),
    latest: recentRows[0]
      ? { thread: publicThread(recentRows[0]), rolloutPath: recentRows[0].rollout_path }
      : null,
  };
}

export function queryThreads(database, {
  limit = 50,
  offset = 0,
  query = "",
  archived = "all",
} = {}) {
  const conditions = [];
  const parameters = [];
  if (archived === "current") conditions.push("archived = 0");
  else if (archived === "archived") conditions.push("archived = 1");

  const trimmedQuery = String(query).trim();
  if (trimmedQuery) {
    conditions.push(`(
      id LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' OR
      COALESCE(model, '') LIKE ? ESCAPE '\\' OR
      COALESCE(thread_source, source, '') LIKE ? ESCAPE '\\' OR
      COALESCE(agent_nickname, '') LIKE ? ESCAPE '\\'
    )`);
    const escaped = trimmedQuery.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    for (let index = 0; index < 5; index += 1) parameters.push(`%${escaped}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const total = database.prepare(`SELECT COUNT(*) AS count FROM threads ${where}`).get(...parameters);
  const rows = database.prepare(`
    SELECT ${PUBLIC_THREAD_COLUMNS}
    FROM threads
    ${where}
    ORDER BY recency_at_ms DESC, updated_at_ms DESC, id DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `).all(...parameters);

  return {
    data: rows.map(publicThread),
    total: toFiniteNumber(total.count),
    limit: safeLimit,
    offset: safeOffset,
  };
}

export function queryLogHealth(database, { now = Date.now() } = {}) {
  const since = Math.floor(now / 1_000) - 86_400;
  const counts = database.prepare(`
    SELECT
      SUM(CASE WHEN upper(level) = 'WARN' THEN 1 ELSE 0 END) AS warnings,
      SUM(CASE WHEN upper(level) = 'ERROR' THEN 1 ELSE 0 END) AS errors,
      COUNT(*) AS total
    FROM logs
    WHERE ts >= ?
  `).get(since);

  const targets = database.prepare(`
    SELECT upper(level) AS level, target, COUNT(*) AS count
    FROM logs
    WHERE ts >= ? AND upper(level) IN ('WARN', 'ERROR')
    GROUP BY upper(level), target
    ORDER BY count DESC
    LIMIT 12
  `).all(since).map((row) => ({
    level: row.level,
    target: row.target || "unknown",
    count: toFiniteNumber(row.count),
  }));

  return {
    warnings24h: toFiniteNumber(counts.warnings),
    errors24h: toFiniteNumber(counts.errors),
    records24h: toFiniteNumber(counts.total),
    targets,
  };
}

export function queryRolloutCandidates(database, { limit = 5_000 } = {}) {
  const safeLimit = Math.max(1, Math.min(5_000, Number(limit) || 5_000));
  const rows = database.prepare(`
    SELECT
      id,
      rollout_path AS rolloutPath,
      archived,
      cwd,
      CASE
        WHEN json_valid(source)
        THEN json_extract(source, '$.subagent.thread_spawn.parent_thread_id')
        ELSE NULL
      END AS parentThreadId,
      CASE
        WHEN lower(replace(COALESCE(thread_source, ''), '_', '')) LIKE '%subagent%'
          OR json_type(CASE WHEN json_valid(source) THEN source END, '$.subagent') IS NOT NULL
        THEN 1
        ELSE 0
      END AS isSubagent,
      substr(COALESCE(agent_nickname, ''), 1, 121) AS agentNickname
    FROM threads
    WHERE rollout_path <> ''
    ORDER BY recency_at_ms DESC, updated_at_ms DESC, id DESC
    LIMIT ${safeLimit + 1}
  `).all();
  rows.scanLimited = rows.length > safeLimit;
  if (rows.scanLimited) rows.length = safeLimit;
  return rows;
}

export function queryRolloutTaskMetadata(database, threadIds) {
  const ids = [...new Set((threadIds || []).map(String).filter(Boolean))].slice(0, 100);
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT id, cwd, archived
    FROM threads
    WHERE id IN (${placeholders})
  `).all(...ids);
  return new Map(rows.map((row) => [String(row.id), {
    cwd: row.cwd ? displayPath(row.cwd) : null,
    archived: Boolean(row.archived),
  }]));
}

export function queryThreadActivityCandidate(database, threadId) {
  const row = database.prepare(`
    SELECT ${PUBLIC_THREAD_COLUMNS}, rollout_path
    FROM threads
    WHERE id = ?
    LIMIT 1
  `).get(threadId);
  return row ? { thread: publicThread(row), rolloutPath: row.rollout_path } : null;
}

export function queryGoalStats(database) {
  const hasTable = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type = 'table' AND name = 'thread_goals'
  `).get();
  if (!hasTable) return null;
  const columns = new Set(database.prepare("PRAGMA table_info(thread_goals)").all().map((row) => row.name));
  if (!columns.has("time_used_seconds") || !columns.has("tokens_used")) return null;
  const activeExpression = columns.has("status")
    ? "SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)"
    : "0";
  const row = database.prepare(`
    SELECT
      COUNT(*) AS goals,
      SUM(tokens_used) AS tokens_used,
      SUM(time_used_seconds) AS time_used_seconds,
      ${activeExpression} AS active_goals
    FROM thread_goals
  `).get();
  return {
    goals: toFiniteNumber(row.goals),
    activeGoals: toFiniteNumber(row.active_goals),
    tokensUsed: toFiniteNumber(row.tokens_used),
    timeUsedSeconds: toFiniteNumber(row.time_used_seconds),
  };
}

export function describeDatabase(databasePath) {
  return databasePath ? displayPath(databasePath) : null;
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  findVersionedDatabase,
  queryAgentCandidates,
  queryGoalStats,
  queryLogHealth,
  queryRolloutCandidates,
  queryRolloutTaskMetadata,
  queryThreadActivityCandidate,
  queryThreadOverview,
  queryThreads,
} from "../src/collectors/sqlite.mjs";

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, created_at_ms INTEGER, updated_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL, source TEXT, thread_source TEXT,
      model_provider TEXT, model TEXT, reasoning_effort TEXT, cwd TEXT,
      tokens_used INTEGER, archived INTEGER, is_pinned INTEGER, cli_version TEXT,
      agent_nickname TEXT, agent_role TEXT
    );
    CREATE TABLE logs (ts INTEGER, level TEXT, target TEXT);
    CREATE TABLE thread_goals (tokens_used INTEGER, time_used_seconds INTEGER, status TEXT);
  `);
  const insert = database.prepare(`
    INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("thread-a", "/tmp/a.jsonl", 1_787_227_000, 1_787_227_100, null, null, 1_787_227_100_000, "cli", "cli", "openai", "gpt-test", "high", "/tmp/project-a", 120, 0, 1, "0.1", null, null);
  insert.run("thread-b", "/tmp/b.jsonl", 1_787_226_000, 1_787_226_500, null, null, 1_787_226_500_000, "app", "subAgent", "openai", "gpt-test", "medium", "/tmp/project-b", 80, 1, 0, "0.1", "helper", "worker");
  database.prepare("UPDATE threads SET source = ? WHERE id = ?").run(JSON.stringify({
    subagent: { thread_spawn: { parent_thread_id: "thread-a" } },
  }), "thread-b");
  database.prepare("INSERT INTO logs VALUES (?, 'WARN', 'codex::one')").run(1_787_227_150);
  database.prepare("INSERT INTO logs VALUES (?, 'ERROR', 'codex::two')").run(1_787_227_160);
  database.prepare("INSERT INTO thread_goals VALUES (50, 12, 'active')").run();
  database.prepare("INSERT INTO thread_goals VALUES (20, 8, 'paused')").run();
  return database;
}

test("SQLite collectors return metadata aggregates without content columns", () => {
  const database = fixtureDatabase();
  try {
    const overview = queryThreadOverview(database, { now: 1_787_227_200_000 });
    assert.equal(overview.stats.threads, 2);
    assert.equal(overview.stats.totalTokens, 200);
    assert.equal(overview.stats.archivedThreads, 1);
    assert.equal(overview.byModel[0].key, "gpt-test");
    assert.deepEqual(overview.byModelReasoning, [
      {
        key: "gpt-test",
        reasoningEffort: "high",
        threads: 1,
        tokens: 120,
        averageTokens: 120,
        averageSpanSeconds: 100,
      },
      {
        key: "gpt-test",
        reasoningEffort: "medium",
        threads: 1,
        tokens: 80,
        averageTokens: 80,
        averageSpanSeconds: 500,
      },
    ]);
    assert.equal(overview.recentThreads[0].id, "thread-a");
    assert.equal(overview.recentThreads[0].tokens, 120);
    assert.equal(overview.recentDaily.length, 14);

    const agentCandidates = queryAgentCandidates(database, { now: 1_787_227_200_000 });
    assert.equal(agentCandidates.length, 1);
    assert.equal(agentCandidates[0].id, "thread-a");
    assert.equal(agentCandidates[0].model, "gpt-test");
    assert.equal(agentCandidates[0].reasoningEffort, "high");
    assert.equal(agentCandidates[0].isSubagent, false);

    const page = queryThreads(database, { query: "project-b", archived: "archived" });
    assert.equal(page.total, 1);
    assert.equal(page.data[0].id, "thread-b");
    const activityCandidate = queryThreadActivityCandidate(database, "thread-a");
    assert.equal(activityCandidate.thread.id, "thread-a");
    assert.equal(activityCandidate.rolloutPath, "/tmp/a.jsonl");
    const rolloutCandidates = queryRolloutCandidates(database, { limit: 1 });
    assert.equal(rolloutCandidates.length, 1);
    assert.equal(rolloutCandidates.scanLimited, true);
    const allRolloutCandidates = queryRolloutCandidates(database, { limit: 2 });
    const childCandidate = allRolloutCandidates.find((candidate) => candidate.id === "thread-b");
    assert.equal(childCandidate.parentThreadId, "thread-a");
    assert.equal(childCandidate.isSubagent, 1);
    assert.equal(childCandidate.agentNickname, "helper");
    assert.deepEqual(queryRolloutTaskMetadata(database, ["thread-a"]).get("thread-a"), {
      cwd: "/tmp/project-a",
      archived: false,
    });

    const logs = queryLogHealth(database, { now: 1_787_227_200_000 });
    assert.equal(logs.warnings24h, 1);
    assert.equal(logs.errors24h, 1);
    assert.ok(logs.targets.every((item) => !("feedback_log_body" in item)));

    assert.deepEqual(queryGoalStats(database), {
      goals: 2,
      activeGoals: 1,
      tokensUsed: 70,
      timeUsedSeconds: 20,
    });
  } finally {
    database.close();
  }
});

test("rollout candidates identify subagents whose parent linkage is unavailable", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT, rollout_path TEXT, archived INTEGER, cwd TEXT, source TEXT,
        thread_source TEXT, agent_nickname TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER
      )
    `);
    database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "unlinked-agent",
      "/tmp/unlinked.jsonl",
      0,
      "/tmp/project",
      JSON.stringify({ subagent: { other: { origin: "internal" } } }),
      "subAgent",
      "reviewer",
      2,
      1,
    );
    const candidate = queryRolloutCandidates(database, { limit: 1 })[0];
    assert.equal(candidate.parentThreadId, null);
    assert.equal(candidate.isSubagent, 1);
    assert.equal(candidate.agentNickname, "reviewer");
  } finally {
    database.close();
  }
});

test("database discovery skips a newer incompatible schema", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-sqlite-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const compatiblePath = path.join(directory, "state_1.sqlite");
  const incompatiblePath = path.join(directory, "state_2.sqlite");
  const compatible = new DatabaseSync(compatiblePath);
  compatible.exec(`
    CREATE TABLE threads (
      id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
      created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER,
      source TEXT, thread_source TEXT, model_provider TEXT, model TEXT,
      reasoning_effort TEXT, cwd TEXT, tokens_used INTEGER, archived INTEGER,
      is_pinned INTEGER, cli_version TEXT, agent_nickname TEXT, agent_role TEXT
    )
  `);
  compatible.close();
  const incompatible = new DatabaseSync(incompatiblePath);
  incompatible.exec("CREATE TABLE threads (id TEXT)");
  incompatible.close();

  assert.equal(await findVersionedDatabase(directory, "state"), compatiblePath);
});

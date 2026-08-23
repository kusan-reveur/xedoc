import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectRunningAgents } from "../src/collectors/agents.mjs";

function event(timestamp, payload) {
  return JSON.stringify({ timestamp, type: "event_msg", payload });
}

test("running-agent collector keeps only recent open turns and safe metadata", async (context) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-agents-"));
  context.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const now = Date.parse("2026-08-23T12:00:00.000Z");
  const runningPath = path.join(codexHome, "running.jsonl");
  const completedPath = path.join(codexHome, "completed.jsonl");
  await fs.writeFile(runningPath, `${event("2026-08-23T11:59:00.000Z", {
    type: "task_started",
    started_at: now / 1_000 - 60,
    private_message: "must not leak",
  })}\n`);
  await fs.writeFile(completedPath, [
    event("2026-08-23T11:58:00.000Z", { type: "task_started", started_at: now / 1_000 - 120 }),
    event("2026-08-23T11:59:30.000Z", { type: "task_complete", completed_at: now / 1_000 - 30 }),
  ].join("\n") + "\n");
  await Promise.all([
    fs.utimes(runningPath, new Date(now), new Date(now)),
    fs.utimes(completedPath, new Date(now), new Date(now)),
  ]);

  const result = await collectRunningAgents([
    {
      id: "running-thread",
      rolloutPath: runningPath,
      model: "gpt-safe",
      reasoningEffort: "high",
      cwd: "~/project",
      tokens: 123,
      agentNickname: "Helper\u202e",
      agentRole: "worker",
      isSubagent: true,
    },
    {
      id: "completed-thread",
      rolloutPath: completedPath,
      model: "gpt-safe",
      reasoningEffort: "medium",
      isSubagent: false,
    },
  ], { codexHome, now });

  assert.equal(result.inspected, 2);
  assert.deepEqual(result.agents, [{
    id: "running-thread",
    kind: "subagent",
    nickname: "Helper",
    role: "worker",
    model: "gpt-safe",
    reasoningEffort: "high",
    project: "~/project",
    tokens: 123,
    runningSince: now - 60_000,
    lastObservedAt: now,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /must not leak/);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseActivityLines, readFileTail } from "../src/collectors/activity.mjs";

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

test("activity parser whitelists metrics and keeps the latest cumulative token count", () => {
  const lines = [
    line("2026-08-20T12:00:00.000Z", "session_meta", { id: "thread-safe", base_instructions: "must not leak" }),
    line("2026-08-20T12:00:01.000Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "secret command" }),
      call_id: "call-1",
    }),
    line("2026-08-20T12:00:02.000Z", "response_item", {
      type: "function_call_output",
      output: "secret output",
      call_id: "call-1",
    }),
    line("2026-08-20T12:00:03.000Z", "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 100, input_tokens: 80, cached_input_tokens: 40, output_tokens: 20 },
        last_token_usage: { total_tokens: 100 },
        model_context_window: 200_000,
      },
    }),
    line("2026-08-20T12:00:04.000Z", "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 150, input_tokens: 120, cached_input_tokens: 50, output_tokens: 30 },
        last_token_usage: { total_tokens: 50 },
        model_context_window: 200_000,
      },
    }),
    line("2026-08-20T12:00:05.000Z", "event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      completed_at: 1_787_227_205,
      duration_ms: 4_200,
      time_to_first_token_ms: 650,
      last_agent_message: "secret answer",
    }),
  ];

  const result = parseActivityLines(lines);
  assert.equal(result.threadId, "thread-safe");
  assert.equal(result.tokenUsage.totalTokens, 150);
  assert.equal(result.tokenUsage.cachedInputTokens, 50);
  assert.equal(result.lastTokenUsage.totalTokens, 50);
  assert.equal(result.contextWindow, 200_000);
  assert.deepEqual(result.turns, {
    completed: 1,
    aborted: 0,
    runtimeMs: 4_200,
    abortedRuntimeMs: null,
    medianTimeToFirstTokenMs: 650,
    sample: 1,
  });
  assert.equal(result.tools[0].name, "exec_command");
  assert.equal(result.tools[0].calls, 1);
  assert.equal(result.tools[0].completed, 1);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret command|secret output|secret answer|base_instructions/);
});

test("activity parser deduplicates completed turns", () => {
  const completion = line("2026-08-20T12:00:05.000Z", "event_msg", {
    type: "task_complete",
    turn_id: "turn-1",
    duration_ms: 1_000,
  });
  const result = parseActivityLines([completion, completion]);
  assert.equal(result.turns.completed, 1);
  assert.equal(result.turns.runtimeMs, 1_000);
});

test("activity parser keeps valid totals when a later token event has null info", () => {
  const result = parseActivityLines([
    line("2026-08-20T12:00:00.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 321, reasoning_output_tokens: 12 } },
    }),
    line("2026-08-20T12:00:01.000Z", "event_msg", { type: "token_count", info: null }),
  ]);
  assert.equal(result.tokenUsage.totalTokens, 321);
  assert.equal(result.tokenUsage.reasoningOutputTokens, 12);
});

test("activity parser reads the direct payload type instead of a nested type", () => {
  const reordered = JSON.stringify({
    timestamp: "2026-08-20T12:00:00.000Z",
    type: "event_msg",
    payload: { nested: { type: "task_complete" }, type: "user_message", message: "private" },
  });
  const result = parseActivityLines([reordered]);
  assert.equal(result.turns.completed, 0);
  assert.equal(result.turns.runtimeMs, null);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("activity parser counts MCP completion metadata without exposing arguments or results", () => {
  const result = parseActivityLines([line("2026-08-20T12:00:02.000Z", "event_msg", {
    type: "mcp_tool_call_end",
    call_id: "mcp-1",
    invocation: { server: "browser", tool: "inspect", arguments: { secret: "do not expose" } },
    duration: { secs: 1, nanos: 250_000_000 },
    result: { content: "private result" },
  })]);
  assert.equal(result.tools[0].name, "browser.inspect");
  assert.equal(result.tools[0].calls, 1);
  assert.equal(result.tools[0].completed, 1);
  assert.equal(result.tools[0].averageDurationMs, 1_250);
  assert.doesNotMatch(JSON.stringify(result), /do not expose|private result|mcp-1/);
});

test("bounded tail reports when one oversized record leaves no complete lines", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-tail-"));
  const file = path.join(directory, "rollout.jsonl");
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(file, `${"x".repeat(256)}\n`);
  const tail = await readFileTail(file, 32);
  assert.equal(tail.truncated, true);
  assert.equal(tail.boundaryRecordSkipped, true);
  assert.equal(tail.noCompleteRecords, true);
  assert.equal(tail.lines.length, 0);
  assert.equal(tail.bytesRead, 32);
});

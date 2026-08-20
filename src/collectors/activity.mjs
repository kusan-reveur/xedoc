import fs from "node:fs/promises";
import { resolveContainedPath, toFiniteNumber } from "../utils.mjs";

const MAX_LINE_BYTES = 768 * 1024;

function timestamp(value, fallback = Date.now()) {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractString(line, key, fromIndex = 0) {
  const keyIndex = line.indexOf(`"${key}"`, fromIndex);
  if (keyIndex < 0) return null;
  const match = line.slice(keyIndex + key.length + 2).match(/^\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function extractNumber(line, key, fromIndex = 0, fallback = null) {
  const keyIndex = line.indexOf(`"${key}"`, fromIndex);
  if (keyIndex < 0) return fallback;
  const match = line.slice(keyIndex + key.length + 2).match(/^\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  return match ? toFiniteNumber(match[1], fallback) : fallback;
}

function extractObject(line, key, fromIndex = 0) {
  const keyIndex = line.indexOf(`"${key}"`, fromIndex);
  if (keyIndex < 0) return "";
  const start = line.indexOf("{", keyIndex + key.length + 2);
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return line.slice(start, index + 1);
  }
  return "";
}

function directPropertyValueIndex(line, key, objectStart) {
  if (objectStart < 0 || line[objectStart] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < line.length; index += 1) {
    const character = line[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return -1;
      continue;
    }
    if (character !== '"' || depth !== 1) continue;
    const keyStart = index;
    inString = true;
    escaped = false;
    for (index += 1; index < line.length; index += 1) {
      const keyCharacter = line[index];
      if (escaped) escaped = false;
      else if (keyCharacter === "\\") escaped = true;
      else if (keyCharacter === '"') break;
    }
    inString = false;
    let parsedKey = null;
    try {
      parsedKey = JSON.parse(line.slice(keyStart, index + 1));
    } catch {
      continue;
    }
    let cursor = index + 1;
    while (/\s/.test(line[cursor] || "")) cursor += 1;
    if (line[cursor] !== ":") continue;
    cursor += 1;
    while (/\s/.test(line[cursor] || "")) cursor += 1;
    if (parsedKey === key) return cursor;
  }
  return -1;
}

function extractDirectString(line, key, objectStart) {
  const valueIndex = directPropertyValueIndex(line, key, objectStart);
  if (valueIndex < 0 || line[valueIndex] !== '"') return null;
  const match = line.slice(valueIndex).match(/^"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function directObjectStart(line, key, objectStart) {
  const valueIndex = directPropertyValueIndex(line, key, objectStart);
  return valueIndex >= 0 && line[valueIndex] === "{" ? valueIndex : -1;
}

function tokenBreakdown(value = "") {
  return {
    totalTokens: extractNumber(value, "total_tokens", 0, 0),
    inputTokens: extractNumber(value, "input_tokens", 0, 0),
    cachedInputTokens: extractNumber(value, "cached_input_tokens", 0, 0),
    cacheWriteInputTokens: extractNumber(value, "cache_write_input_tokens", 0, 0),
    outputTokens: extractNumber(value, "output_tokens", 0, 0),
    reasoningOutputTokens: extractNumber(value, "reasoning_output_tokens", 0, 0),
  };
}

function recordHeader(line) {
  const rootIndex = line.indexOf("{");
  const payloadIndex = directObjectStart(line, "payload", rootIndex);
  return {
    occurredAt: timestamp(extractString(line, "timestamp"), 0),
    recordType: extractDirectString(line, "type", rootIndex),
    payloadType: payloadIndex >= 0 ? extractDirectString(line, "type", payloadIndex) : null,
    payloadIndex,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function publicEvent(type, label, occurredAt, detail = null) {
  return { type, label, occurredAt, detail };
}

export async function readFileTail(filePath, maxBytes = 4 * 1024 * 1024) {
  const handle = await fs.open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("The rollout path is not a regular file");
    const bytes = Math.min(info.size, maxBytes);
    const offset = Math.max(0, info.size - bytes);
    const buffer = Buffer.alloc(bytes);
    let bytesRead = 0;
    while (bytesRead < bytes) {
      const result = await handle.read(buffer, bytesRead, bytes - bytesRead, offset + bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    const boundaryRecordSkipped = offset > 0;
    if (boundaryRecordSkipped) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    if (text && !text.endsWith("\n")) {
      const finalNewline = text.lastIndexOf("\n");
      text = finalNewline >= 0 ? text.slice(0, finalNewline + 1) : "";
    }
    const lines = text.split("\n").filter(Boolean);
    return {
      lines,
      bytesRead,
      fileBytes: info.size,
      modifiedAt: info.mtimeMs,
      truncated: offset > 0,
      boundaryRecordSkipped,
      noCompleteRecords: boundaryRecordSkipped && bytesRead > 0 && lines.length === 0,
    };
  } finally {
    await handle.close();
  }
}

export function parseActivityLines(lines, { maxEvents = 28 } = {}) {
  const events = [];
  const toolCounts = new Map();
  const toolStarts = new Map();
  const timeToFirstToken = [];
  const seenTurns = new Set();
  let tokenUsage = null;
  let lastTokenUsage = null;
  let contextWindow = null;
  let threadId = null;
  let completedTurns = 0;
  let abortedTurns = 0;
  let completedRuntimeMs = 0;
  let abortedRuntimeMs = 0;
  let malformedLines = 0;
  let skippedLargeLines = 0;

  const addEvent = (event) => {
    events.push(event);
    if (events.length > maxEvents * 3) events.shift();
  };

  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      skippedLargeLines += 1;
      continue;
    }

    const header = recordHeader(line);
    if (!header.recordType) {
      malformedLines += 1;
      continue;
    }

    const { occurredAt, payloadIndex, payloadType, recordType } = header;
    if (recordType === "session_meta") {
      threadId = extractDirectString(line, "id", payloadIndex) || extractDirectString(line, "session_id", payloadIndex) || threadId;
      continue;
    }

    if (recordType === "response_item") {
      if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        const name = String(extractDirectString(line, "name", payloadIndex) || "tool").slice(0, 100);
        const current = toolCounts.get(name) || { name, calls: 0, completed: 0, totalDurationMs: 0, lastSeen: 0 };
        current.calls += 1;
        current.lastSeen = Math.max(current.lastSeen, occurredAt);
        toolCounts.set(name, current);
        const callId = extractDirectString(line, "call_id", payloadIndex);
        if (callId) toolStarts.set(callId, { name, occurredAt });
        addEvent(publicEvent("tool", "Tool called", occurredAt, name));
      } else if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
        const callId = extractDirectString(line, "call_id", payloadIndex);
        const started = toolStarts.get(callId);
        if (started) {
          const current = toolCounts.get(started.name);
          current.completed += 1;
          current.totalDurationMs += Math.max(0, occurredAt - started.occurredAt);
          toolStarts.delete(callId);
        }
      }
      continue;
    }

    if (recordType !== "event_msg") continue;
    if (payloadType === "token_count") {
      const totalUsage = extractObject(line, "total_token_usage", payloadIndex);
      const lastUsage = extractObject(line, "last_token_usage", payloadIndex);
      if (totalUsage) tokenUsage = tokenBreakdown(totalUsage);
      if (lastUsage) lastTokenUsage = tokenBreakdown(lastUsage);
      contextWindow = extractNumber(line, "model_context_window", payloadIndex, contextWindow);
    } else if (payloadType === "task_started") {
      addEvent(publicEvent("turn", "Turn started", timestamp(extractNumber(line, "started_at", payloadIndex, occurredAt), occurredAt)));
    } else if (payloadType === "task_complete") {
      const durationMs = extractNumber(line, "duration_ms", payloadIndex, 0);
      const turnKey = extractDirectString(line, "turn_id", payloadIndex) || `${occurredAt}:${durationMs}`;
      if (!seenTurns.has(turnKey)) {
        seenTurns.add(turnKey);
        completedTurns += 1;
        completedRuntimeMs += Math.max(0, durationMs);
        const ttft = extractNumber(line, "time_to_first_token_ms", payloadIndex, -1);
        if (ttft >= 0) timeToFirstToken.push(ttft);
      }
      addEvent(publicEvent("turn", "Turn completed", timestamp(extractNumber(line, "completed_at", payloadIndex, occurredAt), occurredAt)));
    } else if (payloadType === "turn_aborted") {
      const turnKey = extractDirectString(line, "turn_id", payloadIndex) || `${occurredAt}:aborted`;
      if (!seenTurns.has(turnKey)) {
        seenTurns.add(turnKey);
        abortedTurns += 1;
        abortedRuntimeMs += Math.max(0, extractNumber(line, "duration_ms", payloadIndex, 0));
      }
      addEvent(publicEvent("warning", "Turn interrupted", occurredAt));
    } else if (payloadType === "mcp_tool_call_end") {
      const invocationIndex = directObjectStart(line, "invocation", payloadIndex);
      const server = String(extractDirectString(line, "server", invocationIndex) || "mcp").slice(0, 80);
      const tool = String(extractDirectString(line, "tool", invocationIndex) || "tool").slice(0, 100);
      const name = `${server}.${tool}`;
      const durationIndex = directObjectStart(line, "duration", payloadIndex);
      const durationMs = durationIndex < 0 ? 0 : Math.round(
        Math.max(0, extractNumber(line, "secs", durationIndex, 0)) * 1_000
        + Math.max(0, extractNumber(line, "nanos", durationIndex, 0)) / 1_000_000,
      );
      const current = toolCounts.get(name) || { name, calls: 0, completed: 0, totalDurationMs: 0, lastSeen: 0 };
      current.calls += 1;
      current.completed += 1;
      current.totalDurationMs += durationMs;
      current.lastSeen = Math.max(current.lastSeen, occurredAt);
      toolCounts.set(name, current);
      addEvent(publicEvent("tool", "MCP tool completed", occurredAt, name));
    } else if (payloadType === "web_search_end") {
      addEvent(publicEvent("web", "Web search completed", occurredAt));
    } else if (payloadType === "sub_agent_activity") {
      addEvent(publicEvent("agent", "Subagent activity", timestamp(extractNumber(line, "occurred_at_ms", payloadIndex, occurredAt), occurredAt)));
    }
  }

  events.sort((left, right) => right.occurredAt - left.occurredAt);
  const tools = [...toolCounts.values()]
    .sort((left, right) => right.calls - left.calls || right.lastSeen - left.lastSeen)
    .slice(0, 20)
    .map((tool) => ({
      ...tool,
      averageDurationMs: tool.completed ? Math.round(tool.totalDurationMs / tool.completed) : null,
    }));

  return {
    threadId,
    events: events.slice(0, maxEvents),
    tools,
    tokenUsage,
    lastTokenUsage,
    contextWindow,
    turns: {
      completed: completedTurns,
      aborted: abortedTurns,
      runtimeMs: completedTurns ? completedRuntimeMs : null,
      abortedRuntimeMs: abortedTurns ? abortedRuntimeMs : null,
      medianTimeToFirstTokenMs: median(timeToFirstToken),
      sample: seenTurns.size,
    },
    parse: { malformedLines, skippedLargeLines },
  };
}

export async function collectRecentActivity({ codexHome, rolloutPath, maxBytes } = {}) {
  if (!rolloutPath) {
    return { available: false, reason: "No recent rollout is available." };
  }

  try {
    const safeRolloutPath = await resolveContainedPath(codexHome, rolloutPath);
    const tail = await readFileTail(safeRolloutPath, maxBytes);
    const activity = parseActivityLines(tail.lines);
    return {
      available: true,
      ...activity,
      parse: {
        ...activity.parse,
        boundaryRecordSkipped: tail.boundaryRecordSkipped,
        noCompleteRecords: tail.noCompleteRecords,
      },
      file: {
        bytes: tail.fileBytes,
        modifiedAt: tail.modifiedAt,
        bytesInspected: tail.bytesRead,
        tailOnly: tail.truncated,
      },
    };
  } catch (error) {
    return {
      available: false,
      reason: error?.code === "ENOENT" ? "The recent rollout moved or was archived." : "Recent activity could not be read.",
    };
  }
}

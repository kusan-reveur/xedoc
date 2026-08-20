import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { displayPath } from "../config.mjs";
import {
  isInside,
  isSensitivePath,
  posixRelative,
  resolveContainedPath,
  resolveSafeChild,
  runFile,
} from "../utils.mjs";

const TEMP_NAME = /^(?:\.?com\.openai\.codex|codex(?:[-_.]|$)|openai(?:[-_.]|$)|xedoc(?:[-_.]|$))/i;
const MAX_TOP_LEVEL_ENTRIES = 2_048;
const MAX_TEMP_CANDIDATES = 512;
const MAX_TEMP_MATCHES_INSPECTED = 4_096;
const MAX_TEMP_ENTRIES_INSPECTED = 20_000;
const MAX_ROLLOUT_CANDIDATES = 5_000;
const MAX_SESSION_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_INDEX_LINES = 20_000;
const MAX_SESSION_INDEX_LINE_BYTES = 16 * 1024;
const MAX_TASK_NAMES = 100;
const MAX_BROWSER_ENTRIES = 10_000;
const STAT_CONCURRENCY = 16;
const MEASURE_DEADLINE_MS = 15_000;

function categoryFor(name) {
  const lower = name.toLowerCase();
  if (lower === "sessions" || lower === "archived_sessions" || lower === "history.jsonl" || lower === "session_index.jsonl") {
    return ["conversation", "Conversation history"];
  }
  if (/^logs?(?:_|\.|$)/.test(lower) || lower === "log") return ["logs", "Structured logs"];
  if (/^(?:state|goals?)(?:_|\.|$)/.test(lower) || lower === "sqlite" || lower.endsWith(".db")) {
    return ["indexes", "Databases & indexes"];
  }
  if (["packages", "plugins", "skills", "vendor_imports"].includes(lower)) return ["extensions", "Runtimes & extensions"];
  if (["generated_images", "visualizations", "attachments", "appshots"].includes(lower)) return ["artifacts", "User artifacts"];
  if (["cache", ".tmp", "tmp", "node_repl", "browser"].includes(lower)) return ["cache", "Cache & temporary"];
  if (["computer-use", "shell_snapshots", "memories", "process_manager"].includes(lower)) return ["runtime", "Runtime state"];
  if (isSensitivePath(name) || lower.endsWith(".toml") || lower.endsWith(".rules")) return ["configuration", "Configuration & auth"];
  return ["other", "Other local state"];
}

function parseDu(output) {
  const sizes = new Map();
  for (const line of String(output).split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) sizes.set(path.resolve(match[2]), Number(match[1]) * 1_024);
  }
  return sizes;
}

async function measureBatch(paths, timeout) {
  if (!paths.length) return new Map();
  try {
    const { stdout } = await runFile("du", ["-sk", ...paths], { timeout, maxBuffer: 2 * 1024 * 1024 });
    return parseDu(stdout);
  } catch (error) {
    const partial = parseDu(error?.stdout || "");
    await Promise.all(paths.map(async (entryPath) => {
      if (partial.has(path.resolve(entryPath))) return;
      try {
        const info = await fs.lstat(entryPath);
        if (!info.isDirectory()) partial.set(path.resolve(entryPath), info.size);
      } catch {
        // A live Codex process may move an entry between readdir and stat.
      }
    }));
    partial.incomplete = paths.some((entryPath) => !partial.has(path.resolve(entryPath)));
    return partial;
  }
}

export async function measurePaths(paths, { maxPaths = MAX_TOP_LEVEL_ENTRIES, deadlineMs = MEASURE_DEADLINE_MS } = {}) {
  const result = new Map();
  const allUniquePaths = [...new Set(paths.map((entryPath) => path.resolve(entryPath)))];
  const uniquePaths = allUniquePaths.slice(0, maxPaths);
  const deadline = Date.now() + deadlineMs;
  let processedPaths = 0;
  for (let index = 0; index < uniquePaths.length && Date.now() < deadline; index += 64) {
    const batch = uniquePaths.slice(index, index + 64);
    const measured = await measureBatch(batch, Math.max(250, deadline - Date.now()));
    for (const [entryPath, bytes] of measured) result.set(entryPath, bytes);
    if (measured.incomplete) result.incomplete = true;
    processedPaths += batch.length;
  }
  result.scanLimited = allUniquePaths.length > uniquePaths.length || processedPaths < uniquePaths.length;
  return result;
}

async function readDirectoryEntries(directory, limit) {
  const entries = [];
  let truncated = false;
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    entries.push(entry);
  }
  return { entries, truncated };
}

async function appStatePaths() {
  if (process.platform !== "darwin") return [];
  const home = os.homedir();
  return [
    ["app-support", "App support", path.join(home, "Library", "Application Support", "Codex"), "Persistent app profile"],
    ["app-cache", "App cache", path.join(home, "Library", "Caches", "Codex"), "Cache"],
    ["update-cache", "Update cache", path.join(home, "Library", "Caches", "com.openai.codex"), "Cache"],
    ["app-logs", "App logs", path.join(home, "Library", "Logs", "com.openai.codex"), "Logs"],
    ["http-storage", "HTTP storage", path.join(home, "Library", "HTTPStorages", "com.openai.codex"), "Sensitive app state"],
  ];
}

async function existingPaths(definitions) {
  const output = [];
  for (const [name, label, entryPath, classification] of definitions) {
    try {
      const info = await fs.lstat(entryPath);
      if (info.isSymbolicLink()) continue;
      output.push({ name, label, path: entryPath, realPath: await fs.realpath(entryPath), classification });
    } catch {
      // Optional app state varies by platform and installation.
    }
  }
  return output;
}

async function scanTempCandidates(codexHome) {
  const roots = [];
  const rootSet = new Set();
  for (const candidate of [os.tmpdir(), "/tmp", "/private/tmp"]) {
    try {
      const real = await fs.realpath(candidate);
      if (!rootSet.has(real)) {
        rootSet.add(real);
        roots.push(real);
      }
    } catch {
      // Missing platform-specific temp roots are harmless.
    }
  }
  const candidates = [];
  const seen = new Set();
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  let inspectedMatches = 0;
  let inspectedEntries = 0;
  let truncated = false;
  for (const root of roots) {
    let handle;
    try {
      handle = await fs.opendir(root);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_TEMP_ENTRIES_INSPECTED) {
        truncated = true;
        break;
      }
      if (!TEMP_NAME.test(entry.name)) continue;
      inspectedMatches += 1;
      if (inspectedMatches > MAX_TEMP_MATCHES_INSPECTED || candidates.length >= MAX_TEMP_CANDIDATES) {
        truncated = true;
        break;
      }
      const entryPath = path.join(root, entry.name);
      if (seen.has(entryPath) || entry.isSymbolicLink() || isInside(entryPath, codexHome) || isInside(codexHome, entryPath)) continue;
      try {
        const info = await fs.lstat(entryPath);
        if (info.isSymbolicLink() || (currentUid !== null && info.uid !== currentUid)) continue;
        seen.add(entryPath);
        candidates.push({ path: entryPath, name: entry.name, root, info });
      } catch {
        // Temporary entries are expected to disappear while scanning.
      }
    }
    if (truncated) break;
  }

  const sizes = await measurePaths(candidates.map((item) => item.path), { maxPaths: MAX_TEMP_CANDIDATES });
  const result = [];
  for (const candidate of candidates) {
    try {
      const info = await fs.lstat(candidate.path);
      if (currentUid !== null && info.uid !== currentUid) continue;
      result.push({
        name: candidate.name,
        path: `${displayPath(candidate.root)}/${candidate.name}`,
        bytes: sizes.get(path.resolve(candidate.path)) ?? (info.isDirectory() ? null : info.size),
        modifiedAt: info.mtimeMs,
        kind: info.isDirectory() ? "directory" : "file",
      });
    } catch {
      // Temporary entries are expected to disappear while scanning.
    }
  }
  result.sort((left, right) => right.bytes - left.bytes || right.modifiedAt - left.modifiedAt);
  return {
    files: result,
    truncated,
    measurementLimited: Boolean(sizes.incomplete || sizes.scanLimited),
  };
}

export async function collectStorage(codexHome) {
  const generatedAt = Date.now();
  if (process.platform === "win32") {
    return {
      available: false,
      error: "Directory disk-size collection is not available on Windows in this build.",
      updatedAt: generatedAt,
      totalBytes: null,
      codexHomeBytes: null,
      groups: [],
      entries: [],
      tempFiles: [],
      tempFileCount: null,
      tempBytes: null,
    };
  }
  let entries = [];
  let entryScanLimited = false;
  let canonicalCodexHome;
  try {
    canonicalCodexHome = await fs.realpath(codexHome);
    const listing = await readDirectoryEntries(codexHome, MAX_TOP_LEVEL_ENTRIES);
    entries = listing.entries;
    entryScanLimited = listing.truncated;
  } catch (error) {
    return {
      available: false,
      error: error?.code === "ENOENT" ? "CODEX_HOME does not exist." : "CODEX_HOME cannot be scanned.",
      updatedAt: generatedAt,
      totalBytes: null,
      codexHomeBytes: null,
      groups: [],
      entries: [],
      tempFiles: [],
      tempFileCount: null,
      tempBytes: null,
    };
  }

  const localEntries = entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: path.join(codexHome, entry.name), kind: entry.isDirectory() ? "directory" : "file" }));
  const external = (await existingPaths(await appStatePaths()))
    .filter((item) => !isInside(item.realPath, canonicalCodexHome) && !isInside(canonicalCodexHome, item.realPath));
  const sizes = await measurePaths([...localEntries.map((item) => item.path), ...external.map((item) => item.path)]);

  const categories = new Map();
  const publicEntries = [];
  for (const entry of localEntries) {
    const [name, label] = categoryFor(entry.name);
    const bytes = sizes.get(path.resolve(entry.path)) || 0;
    const current = categories.get(name) || { name, label, bytes: 0, entries: 0 };
    current.bytes += bytes;
    current.entries += 1;
    categories.set(name, current);
    publicEntries.push({
      name: entry.name,
      path: entry.name,
      kind: entry.kind,
      bytes,
      category: name,
      sensitive: isSensitivePath(entry.name),
    });
  }

  const externalGroups = external.map((item) => ({
    name: item.name,
    label: item.label,
    bytes: sizes.get(path.resolve(item.path)) || 0,
    entries: 1,
    classification: item.classification,
    path: displayPath(item.path),
    external: true,
  }));

  const tempScan = await scanTempCandidates(canonicalCodexHome);
  const tempFiles = tempScan.files;
  const tempBytes = tempFiles.reduce((sum, item) => sum + (item.bytes || 0), 0);
  if (tempFiles.length) {
    externalGroups.push({
      name: "system-temp",
      label: "System temporary",
      bytes: tempBytes,
      entries: tempFiles.length,
      classification: "Temporary candidates",
      path: "$TMPDIR / /tmp",
      external: true,
    });
  }

  const groups = [...categories.values(), ...externalGroups]
    .sort((left, right) => right.bytes - left.bytes);
  publicEntries.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));

  return {
    available: true,
    error: null,
    updatedAt: generatedAt,
    totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0),
    codexHomeBytes: [...categories.values()].reduce((sum, group) => sum + group.bytes, 0),
    groups,
    entries: publicEntries,
    tempFiles: tempFiles.slice(0, 150),
    tempFileCount: tempFiles.length,
    tempScanLimited: tempScan.truncated,
    tempMeasurementLimited: tempScan.measurementLimited,
    tempBytes,
    entryScanLimited,
    measurementLimited: Boolean(sizes.incomplete || sizes.scanLimited || tempScan.measurementLimited),
    note: "Conversation history is persistent state, not disposable cache. Sizes are allocated disk usage where supported.",
  };
}

export async function collectLargestRollouts(candidates, codexHome, limit = 20) {
  const allCandidates = candidates || [];
  const source = allCandidates.slice(0, MAX_ROLLOUT_CANDIDATES);
  const rows = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(STAT_CONCURRENCY, source.length) }, async () => {
    while (nextIndex < source.length) {
      const candidate = source[nextIndex++];
      let row = null;
      try {
        if (!isInside(codexHome, candidate.rolloutPath)) continue;
        const safePath = await resolveContainedPath(codexHome, candidate.rolloutPath);
        const info = await fs.lstat(safePath);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        row = {
          threadId: candidate.id,
          path: posixRelative(codexHome, candidate.rolloutPath),
          bytes: info.size,
          allocatedBytes: typeof info.blocks === "number" ? info.blocks * 512 : null,
          modifiedAt: info.mtimeMs,
          archived: Boolean(candidate.archived),
        };
      } catch {
        // Rollouts can move or archive while metadata is collected.
      }
      if (row) rows.push(row);
    }
  });
  await Promise.all(workers);
  const result = rows.sort((left, right) => right.bytes - left.bytes).slice(0, limit);
  result.scanLimited = Boolean(allCandidates.scanLimited || allCandidates.length > MAX_ROLLOUT_CANDIDATES);
  return result;
}

function cleanTaskName(value, maximum = 120) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return normalized.length > maximum
    ? `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`
    : normalized;
}

export async function collectSessionIndexNames(codexHome, threadIds) {
  const wanted = new Set([...new Set((threadIds || []).map(String).filter(Boolean))].slice(0, MAX_TASK_NAMES));
  const names = new Map();
  if (!wanted.size) return names;

  let handle;
  try {
    const indexPath = path.join(codexHome, "session_index.jsonl");
    const sourceInfo = await fs.lstat(indexPath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) return names;
    const safePath = await resolveContainedPath(codexHome, indexPath);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await fs.open(safePath, fsConstants.O_RDONLY | noFollow);
    const info = await handle.stat();
    if (!info.isFile()) return names;
    const bytesToRead = Math.min(info.size, MAX_SESSION_INDEX_BYTES);
    const start = Math.max(0, info.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const boundary = text.indexOf("\n");
      if (boundary < 0) return names;
      text = text.slice(boundary + 1);
    }
    let lineEnd = text.length;
    let linesInspected = 0;
    while (lineEnd >= 0 && linesInspected < MAX_SESSION_INDEX_LINES && names.size < wanted.size) {
      const boundary = text.lastIndexOf("\n", Math.max(0, lineEnd - 1));
      const line = text.slice(boundary + 1, lineEnd);
      lineEnd = boundary <= 0 ? -1 : boundary;
      linesInspected += 1;
      if (!line || Buffer.byteLength(line) > MAX_SESSION_INDEX_LINE_BYTES) continue;
      try {
        const record = JSON.parse(line);
        const id = typeof record?.id === "string" ? record.id : "";
        if (!wanted.has(id) || names.has(id)) continue;
        names.set(id, cleanTaskName(record?.thread_name));
      } catch {
        // A live append or incompatible record should not hide the remaining index.
      }
    }
  } catch {
    // The compact session-name index is optional and may move while Codex is active.
  } finally {
    await handle?.close().catch(() => {});
  }
  return names;
}

function rootThreadId(threadId, candidatesById) {
  let current = String(threadId || "");
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    const parent = candidatesById.get(current)?.parentThreadId;
    if (!parent) return current;
    current = String(parent);
  }
  return String(threadId || "");
}

export function groupLargestRollouts(rollouts, candidates, limit = 24) {
  const candidatesById = new Map((candidates || []).map((candidate) => [String(candidate.id), candidate]));
  const groups = new Map();
  for (const rollout of rollouts || []) {
    const taskId = rootThreadId(rollout.threadId, candidatesById);
    if (!taskId) continue;
    let group = groups.get(taskId);
    if (!group) {
      group = {
        threadId: taskId,
        bytes: 0,
        allocatedBytes: 0,
        allocationComplete: true,
        modifiedAt: 0,
        rolloutCount: 0,
        largestRolloutPath: null,
        largestRolloutBytes: -1,
        memberArchived: true,
        fallbackCwd: null,
      };
      groups.set(taskId, group);
    }
    group.bytes += Number(rollout.bytes) || 0;
    if (Number.isFinite(rollout.allocatedBytes)) group.allocatedBytes += rollout.allocatedBytes;
    else group.allocationComplete = false;
    group.modifiedAt = Math.max(group.modifiedAt, Number(rollout.modifiedAt) || 0);
    group.rolloutCount += 1;
    group.memberArchived = group.memberArchived && Boolean(rollout.archived);
    group.fallbackCwd ||= candidatesById.get(String(rollout.threadId))?.cwd || null;
    if ((Number(rollout.bytes) || 0) > group.largestRolloutBytes) {
      group.largestRolloutBytes = Number(rollout.bytes) || 0;
      group.largestRolloutPath = rollout.path;
    }
  }

  const result = [...groups.values()]
    .map((group) => {
      const root = candidatesById.get(group.threadId);
      const unlinkedSubagent = Boolean(root?.isSubagent);
      return {
        threadId: group.threadId,
        taskName: null,
        unlinkedSubagent,
        agentNickname: unlinkedSubagent ? cleanTaskName(root?.agentNickname, 80) : null,
        cwd: root?.cwd ? displayPath(root.cwd) : group.fallbackCwd ? displayPath(group.fallbackCwd) : null,
        archived: root ? Boolean(root.archived) : group.memberArchived,
        rolloutCount: group.rolloutCount,
        bytes: group.bytes,
        allocatedBytes: group.allocationComplete ? group.allocatedBytes : null,
        modifiedAt: group.modifiedAt || null,
        largestRolloutPath: group.largestRolloutPath,
      };
    })
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 24)));
  result.scanLimited = Boolean(rollouts?.scanLimited || candidates?.scanLimited);
  return result;
}

export async function listDirectory(codexHome, relativePath = "", { offset = 0, limit = 100 } = {}) {
  const target = await resolveSafeChild(codexHome, relativePath);
  const targetInfo = await fs.lstat(target);
  if (!targetInfo.isDirectory()) throw new Error("The requested path is not a directory");
  const listing = await readDirectoryEntries(target, MAX_BROWSER_ENTRIES);
  const entries = listing.entries;
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const page = entries.slice(offset, offset + limit);
  const data = await Promise.all(page.map(async (entry) => {
    const entryPath = path.join(target, entry.name);
    try {
      const info = await fs.lstat(entryPath);
      const relative = posixRelative(codexHome, entryPath);
      return {
        name: entry.name,
        path: relative,
        kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        bytes: info.isFile() ? info.size : null,
        allocatedBytes: info.isFile() && typeof info.blocks === "number" ? info.blocks * 512 : null,
        modifiedAt: info.mtimeMs,
        sensitive: isSensitivePath(relative),
      };
    } catch {
      return null;
    }
  }));

  return {
    scope: "codex",
    path: posixRelative(codexHome, target),
    displayPath: displayPath(target),
    data: data.filter(Boolean),
    total: entries.length,
    offset,
    limit,
    scanLimited: listing.truncated,
  };
}

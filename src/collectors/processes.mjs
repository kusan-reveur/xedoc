import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { displayPath } from "../config.mjs";
import { isInside, parseElapsed, runFile, toFiniteNumber } from "../utils.mjs";

function parsePsLine(line) {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    uid: Number(match[3]),
    cpuPercent: Number(match[4]),
    rssBytes: Number(match[5]) * 1_024,
    elapsedSec: parseElapsed(match[6]),
    executable: match[7],
  };
}

function codexRootKind(process) {
  const executable = process.executable.toLowerCase();
  const basename = path.basename(executable).toLowerCase();
  const appBundleHost = executable.includes("/codex.app/")
    || executable.includes("/chatgpt.app/")
    || executable.includes("\\codex.app\\")
    || executable.includes("\\chatgpt.app\\");
  const mainAppExecutable = /\/(?:codex|chatgpt)\.app\/contents\/macos\/(?:codex|chatgpt)$/.test(executable);
  if (mainAppExecutable) return "host";
  const worker = basename === "codex"
    || basename === "codex-macos"
    || basename === "codex-code-mode-host"
    || basename === "codex.exe";
  if (worker) return "worker";
  if (appBundleHost) return "host";
  const host = basename === "chatgpt"
    || basename.startsWith("chatgpt ")
    || basename.startsWith("codex ")
    || executable.includes("\\codex\\")
    || executable.includes("\\chatgpt\\");
  return host ? "host" : null;
}

export function selectCodexProcessTree(processes, { uid = null } = {}) {
  const ownedProcesses = uid === null ? processes : processes.filter((item) => item.uid === uid);
  const rootKinds = new Map(ownedProcesses.map((item) => [item.pid, codexRootKind(item)]).filter(([, kind]) => kind));
  const selected = new Map(rootKinds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of ownedProcesses) {
      if (!selected.has(process.pid) && selected.has(process.parentPid)) {
        selected.set(process.pid, selected.get(process.parentPid));
        changed = true;
      }
    }
  }

  return ownedProcesses
    .filter((process) => selected.has(process.pid))
    .map((process) => ({
      ...process,
      group: selected.get(process.pid),
      role: rootKinds.has(process.pid) ? rootKinds.get(process.pid) : "spawned",
    }));
}

export function parsePsOutput(output) {
  return String(output).split("\n").map(parsePsLine).filter(Boolean);
}

function publicProcess(process) {
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    name: path.basename(process.executable).slice(0, 120),
    role: process.role,
    group: process.group,
    cpuPercent: toFiniteNumber(process.cpuPercent),
    rssBytes: toFiniteNumber(process.rssBytes),
    elapsedSec: toFiniteNumber(process.elapsedSec),
  };
}

export async function collectProcesses() {
  if (process.platform === "win32") {
    return {
      supported: false,
      error: "Windows process collection is not available in this build.",
      processes: [],
      processCount: 0,
      workerProcessCount: 0,
      workerTreeProcessCount: 0,
      coreProcessCount: 0,
      totalRssBytes: 0,
      workerRssBytes: 0,
      workerTreeRssBytes: 0,
      coreRssBytes: 0,
      totalCpuPercent: 0,
      longestUptimeSec: 0,
    };
  }

  try {
    const ps = process.platform === "darwin" ? "/bin/ps" : "ps";
    const { stdout } = await runFile(ps, ["-ww", "-axo", "pid=,ppid=,uid=,%cpu=,rss=,etime=,comm="], {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 4_000,
    });
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const selected = selectCodexProcessTree(parsePsOutput(stdout), { uid: currentUid });
    const publicProcesses = selected.map(publicProcess).sort((left, right) => {
      if (left.group !== right.group) return left.group === "worker" ? -1 : 1;
      if (left.role !== right.role) return left.role === "spawned" ? 1 : -1;
      return right.rssBytes - left.rssBytes;
    });
    return {
      supported: true,
      error: null,
      processes: publicProcesses,
      processCount: publicProcesses.length,
      workerProcessCount: publicProcesses.filter((item) => item.role === "worker").length,
      workerTreeProcessCount: publicProcesses.filter((item) => item.group === "worker").length,
      coreProcessCount: publicProcesses.filter((item) => item.role === "worker").length,
      totalRssBytes: publicProcesses.reduce((sum, item) => sum + item.rssBytes, 0),
      workerRssBytes: publicProcesses.filter((item) => item.role === "worker").reduce((sum, item) => sum + item.rssBytes, 0),
      workerTreeRssBytes: publicProcesses.filter((item) => item.group === "worker").reduce((sum, item) => sum + item.rssBytes, 0),
      coreRssBytes: publicProcesses.filter((item) => item.role === "worker").reduce((sum, item) => sum + item.rssBytes, 0),
      totalCpuPercent: publicProcesses.reduce((sum, item) => sum + item.cpuPercent, 0),
      longestUptimeSec: publicProcesses.reduce((maximum, item) => Math.max(maximum, item.elapsedSec), 0),
      note: "Aggregate RSS can double-count shared memory; CPU is OS-reported and platform-averaged; spawned work includes child tools and shells.",
    };
  } catch (error) {
    return {
      supported: false,
      error: error?.code === "EPERM"
        ? "Process metrics are blocked by the current permission context."
        : "Process metrics are unavailable in the current permission context.",
      processes: [],
      processCount: 0,
      workerProcessCount: 0,
      workerTreeProcessCount: 0,
      coreProcessCount: 0,
      totalRssBytes: 0,
      workerRssBytes: 0,
      workerTreeRssBytes: 0,
      coreRssBytes: 0,
      totalCpuPercent: 0,
      longestUptimeSec: 0,
    };
  }
}

function normalizeOpenPath(value) {
  const deleted = value.endsWith(" (deleted)");
  return { path: deleted ? value.slice(0, -10) : value, deleted };
}

export async function collectOpenFiles({ processes, codexHome, limit = 120, runtimeSupported = true } = {}) {
  if (process.platform === "win32" || !runtimeSupported) {
    return { available: false, error: "Open-file metadata is unavailable with the current process permissions.", items: [], limited: false };
  }
  if (!processes?.length) return { available: true, error: null, items: [], limited: false };
  const pids = processes.map((item) => item.pid).join(",");
  let stdout;
  let partial = false;
  try {
    ({ stdout } = await runFile("lsof", ["-n", "-P", "-F", "pfn", "-p", pids], { timeout: 5_000 }));
  } catch (error) {
    stdout = error?.stdout || "";
    if (!stdout) return { available: false, error: "Open-file metadata is unavailable because lsof could not be read.", items: [], limited: false };
    partial = true;
  }

  const tempRoots = [...new Set([os.tmpdir(), "/tmp", "/private/tmp"].map((item) => path.resolve(item)))];
  const matches = [];
  const seen = new Set();
  let pid = null;
  let descriptor = null;
  let limited = false;
  for (const line of stdout.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") pid = Number(value);
    else if (field === "f") descriptor = value;
    else if (field === "n" && value.startsWith("/")) {
      const normalized = normalizeOpenPath(value);
      const inState = isInside(codexHome, normalized.path);
      const inTemp = tempRoots.some((root) => isInside(root, normalized.path));
      if (!inState && !inTemp) continue;
      const key = `${pid}:${descriptor}:${normalized.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        pid,
        descriptor,
        path: displayPath(normalized.path),
        location: inState ? "Codex state" : "System temporary",
        deleted: normalized.deleted,
      });
      if (matches.length >= limit) {
        limited = true;
        break;
      }
    }
  }

  await Promise.all(matches.map(async (item) => {
    if (item.deleted) return;
    try {
      const absolute = item.path.startsWith("~")
        ? path.join(os.homedir(), item.path.slice(2))
        : item.path;
      const info = await fs.lstat(absolute);
      item.bytes = info.isFile() ? info.size : null;
      item.modifiedAt = info.mtimeMs;
    } catch {
      item.bytes = null;
    }
  }));
  return { available: true, error: partial ? "lsof returned partial metadata." : null, items: matches, limited };
}

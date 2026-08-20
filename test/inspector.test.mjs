import assert from "node:assert/strict";
import test from "node:test";
import { CodexInspector } from "../src/inspector.mjs";

test("snapshot reports the installed CLI version instead of the latest task writer", async () => {
  const order = [];
  const inspector = new CodexInspector({ codexHome: "/tmp/xedoc-version-test" });
  inspector.databasePaths = async () => ({ state: "state.sqlite", logs: null, goals: null });
  inspector.readOverview = () => ({
    stats: { threads: 1, currentThreads: 1, archivedThreads: 0, activeThreads: 0, totalTokens: 0 },
    byModel: [],
    recentDaily: [],
    recentThreads: [],
    latest: {
      thread: { id: "latest-thread", cliVersion: "0.148.0-alpha.9" },
      rolloutPath: null,
    },
  });
  inspector.readLogs = () => ({
    available: false,
    warnings24h: 0,
    errors24h: 0,
    records24h: 0,
    targets: [],
  });
  inspector.readGoals = () => null;
  inspector.codexVersion = async () => {
    order.push("version");
    return "codex-cli 0.146.0";
  };
  inspector.storageCache.get = async () => ({
    available: false,
    error: "unavailable",
    groups: [],
    entries: [],
    tempFiles: [],
  });
  inspector.processCache.get = async () => {
    order.push("process");
    return { supported: false, error: "unavailable", processes: [] };
  };
  inspector.recentActivity = async () => ({ available: false });
  inspector.largestRollouts = async () => [];

  const snapshot = await inspector.snapshot();
  assert.equal(snapshot.codex.version, "codex-cli 0.146.0");
  assert.deepEqual(order, ["version", "process"]);
});

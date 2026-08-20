import os from "node:os";
import { displayPath } from "./config.mjs";
import { collectRecentActivity } from "./collectors/activity.mjs";
import {
  collectArtificialAnalysisModels,
  collectResetHistory,
} from "./collectors/external.mjs";
import { collectOpenFiles, collectProcesses } from "./collectors/processes.mjs";
import {
  describeDatabase,
  findVersionedDatabase,
  queryGoalStats,
  queryLogHealth,
  queryRolloutCandidates,
  queryThreadActivityCandidate,
  queryThreadOverview,
  queryThreads,
  withReadonlyDatabase,
} from "./collectors/sqlite.mjs";
import {
  collectLargestRollouts,
  collectStorage,
  listDirectory,
} from "./collectors/storage.mjs";
import { runFile, TtlCache } from "./utils.mjs";

const EMPTY_THREAD_OVERVIEW = {
  stats: { threads: null, currentThreads: null, archivedThreads: null, activeThreads: null, totalTokens: null },
  byModel: [],
  recentDaily: [],
  recentThreads: [],
  latest: null,
};

const EMPTY_LOG_HEALTH = {
  warnings24h: 0,
  errors24h: 0,
  records24h: 0,
  targets: [],
};

function publicExternalReason(error, fallback) {
  const message = String(error?.message || "");
  return /^(?:The remote API|Network requests are unavailable)/.test(message) ? message : fallback;
}

export class CodexInspector {
  constructor({
    codexHome,
    sqliteHome = codexHome,
    fetchImpl = globalThis.fetch,
    artificialAnalysisApiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY,
  } = {}) {
    this.codexHome = codexHome;
    this.sqliteHome = sqliteHome;
    this.fetchImpl = fetchImpl;
    this.artificialAnalysisApiKey = artificialAnalysisApiKey;
    this.databaseCache = new TtlCache(10_000);
    this.storageCache = new TtlCache(60_000);
    this.processCache = new TtlCache(2_000);
    this.versionCache = new TtlCache(300_000);
    this.activityCache = new Map();
    this.activityTtlMs = 10_000;
    this.rolloutCache = new TtlCache(60_000);
    this.resetHistoryCache = new TtlCache(5 * 60_000);
    this.modelPerformanceCache = new TtlCache(12 * 60 * 60_000);
  }

  async recentActivity({ rolloutPath, thread = null, threadId = null } = {}) {
    if (!rolloutPath) {
      const activity = await collectRecentActivity({ codexHome: this.codexHome, rolloutPath });
      return { ...activity, threadId: threadId || thread?.id || activity.threadId || null, thread };
    }

    const key = String(rolloutPath);
    const now = Date.now();
    const cached = this.activityCache.get(key);
    if (cached?.value && cached.expiresAt > now) return cached.value;
    if (cached?.pending) return cached.pending;

    const pending = collectRecentActivity({ codexHome: this.codexHome, rolloutPath })
      .then((activity) => ({
        ...activity,
        threadId: threadId || thread?.id || activity.threadId || null,
        thread,
      }))
      .then((value) => {
        this.activityCache.set(key, { value, expiresAt: Date.now() + this.activityTtlMs });
        if (this.activityCache.size > 64) this.activityCache.delete(this.activityCache.keys().next().value);
        return value;
      })
      .catch((error) => {
        this.activityCache.delete(key);
        throw error;
      });
    this.activityCache.set(key, { pending, expiresAt: 0 });
    return pending;
  }

  async databasePaths() {
    return this.databaseCache.get(async () => ({
      state: await findVersionedDatabase(this.sqliteHome, "state"),
      logs: await findVersionedDatabase(this.sqliteHome, "logs"),
      goals: await findVersionedDatabase(this.sqliteHome, "goals"),
    }));
  }

  async codexVersion() {
    return this.versionCache.get(async () => {
      try {
        const { stdout, stderr } = await runFile(process.env.CODEX_BIN || "codex", ["--version"], { timeout: 3_000 });
        return String(stdout || stderr).trim().split("\n")[0].slice(0, 120) || "unknown";
      } catch {
        return "unavailable";
      }
    });
  }

  readOverview(databasePath) {
    if (!databasePath) return { ...EMPTY_THREAD_OVERVIEW, error: "No compatible state database was found." };
    try {
      return withReadonlyDatabase(databasePath, (database) => queryThreadOverview(database));
    } catch {
      return { ...EMPTY_THREAD_OVERVIEW, error: "The state database schema is not compatible with this Xedoc build." };
    }
  }

  readLogs(databasePath) {
    if (!databasePath) return { ...EMPTY_LOG_HEALTH, available: false };
    try {
      return { ...withReadonlyDatabase(databasePath, (database) => queryLogHealth(database)), available: true };
    } catch {
      return { ...EMPTY_LOG_HEALTH, available: false };
    }
  }

  readGoals(databasePath) {
    if (!databasePath) return null;
    try {
      return withReadonlyDatabase(databasePath, (database) => queryGoalStats(database));
    } catch {
      return null;
    }
  }

  async largestRollouts(databasePath) {
    if (!databasePath) return [];
    return this.rolloutCache.get(async () => {
      try {
        const candidates = withReadonlyDatabase(databasePath, (database) => queryRolloutCandidates(database));
        return collectLargestRollouts(candidates, this.codexHome, 24);
      } catch {
        return [];
      }
    });
  }

  async snapshot({ forceStorage = false } = {}) {
    const startedAt = Date.now();
    const pathsPromise = this.databasePaths();
    const storagePromise = this.storageCache.get(() => collectStorage(this.codexHome), { force: forceStorage });
    const paths = await pathsPromise;
    const overview = this.readOverview(paths.state);
    const logs = this.readLogs(paths.logs);
    const goals = this.readGoals(paths.goals);
    const versionPromise = overview.latest?.thread?.cliVersion
      ? Promise.resolve(`codex-cli ${overview.latest.thread.cliVersion}`)
      : this.codexVersion();
    const runtimePromise = this.processCache.get(() => collectProcesses());

    const activityPromise = this.recentActivity({
      rolloutPath: overview.latest?.rolloutPath,
      thread: overview.latest?.thread || null,
      threadId: overview.latest?.thread?.id || null,
    });

    const [runtime, storage, version, activity, largestRollouts] = await Promise.all([
      runtimePromise,
      storagePromise,
      versionPromise,
      activityPromise,
      this.largestRollouts(paths.state),
    ]);
    const openFileResult = await collectOpenFiles({
      processes: runtime.processes,
      codexHome: this.codexHome,
      runtimeSupported: runtime.supported,
    });

    storage.largestRollouts = largestRollouts;
    storage.rolloutScanLimited = Boolean(largestRollouts.scanLimited);
    storage.openFiles = openFileResult.items;
    storage.openFilesAvailable = openFileResult.available;
    storage.openFilesLimited = openFileResult.limited;
    storage.openFilesError = openFileResult.error;
    const healthWarnings = [];
    if (overview.error) healthWarnings.push({ level: "warning", title: "Thread index unavailable", detail: overview.error });
    if (!logs.available) {
      healthWarnings.push({
        level: "info",
        title: "Structured log metadata unavailable",
        detail: "Warning and error counters are unknown, not zero.",
      });
    }
    if (!runtime.supported) healthWarnings.push({ level: "info", title: "Process metrics unavailable", detail: runtime.error });
    if (!openFileResult.available) {
      healthWarnings.push({ level: "info", title: "Open-file metadata unavailable", detail: openFileResult.error });
    }
    if (openFileResult.limited) {
      healthWarnings.push({
        level: "info",
        title: "Open-file scan reached its safety limit",
        detail: "The open-file count and list are partial and are marked with a plus sign.",
      });
    }
    if (!storage.available) healthWarnings.push({ level: "warning", title: "Storage scan unavailable", detail: storage.error });
    if (storage.entryScanLimited) {
      healthWarnings.push({
        level: "info",
        title: "Storage entry scan reached its safety limit",
        detail: "Top-level CODEX_HOME results are partial to keep collection bounded.",
      });
    }
    if (storage.measurementLimited) {
      healthWarnings.push({
        level: "info",
        title: "Some directory sizes could not be measured",
        detail: "Storage totals are partial because a size command was unavailable, timed out, or hit a scan budget.",
      });
    }
    if (storage.tempScanLimited) {
      healthWarnings.push({
        level: "info",
        title: "Temporary-entry scan reached its safety limit",
        detail: "The temporary file count and size are partial and are marked with a plus sign.",
      });
    }
    if (storage.rolloutScanLimited) {
      healthWarnings.push({
        level: "info",
        title: "Largest-rollout scan used recent candidates",
        detail: "Results are the largest files among the 5,000 most recently indexed rollout paths.",
      });
    }
    if (logs.errors24h > 0) {
      healthWarnings.push({
        level: "warning",
        title: `${logs.errors24h.toLocaleString()} error log records in 24 hours`,
        detail: "Only severity and target metadata are shown; log bodies remain private.",
      });
    }
    const conversationBytes = storage.groups?.find((group) => group.name === "conversation")?.bytes || 0;
    if (conversationBytes >= 10 * 1024 ** 3) {
      healthWarnings.push({
        level: "info",
        title: "Conversation history is using substantial disk space",
        detail: "These rollouts are persistent chat history, not ordinary temporary files. Xedoc never deletes them.",
      });
    }
    if (activity?.parse?.skippedLargeLines) {
      healthWarnings.push({
        level: "info",
        title: "Large content records were skipped",
        detail: "The activity reader intentionally ignores large JSONL records to avoid loading prompts, images, or tool output.",
      });
    }
    if (activity?.parse?.noCompleteRecords) {
      healthWarnings.push({
        level: "info",
        title: "Recent rollout tail contains one oversized record",
        detail: "No complete metadata record fit inside the bounded tail, so recent activity counters are unavailable.",
      });
    }

    return {
      generatedAt: Date.now(),
      collectionDurationMs: Date.now() - startedAt,
      codex: {
        home: displayPath(this.codexHome),
        sqliteHome: displayPath(this.sqliteHome),
        version,
        platform: `${process.platform} ${os.arch()}`,
        nodeVersion: process.version,
      },
      stats: {
        ...overview.stats,
        storageBytes: storage.available ? (storage.totalBytes || 0) : null,
        codexHomeBytes: storage.available ? (storage.codexHomeBytes || 0) : null,
        warnings24h: logs.available ? logs.warnings24h : null,
        errors24h: logs.available ? logs.errors24h : null,
      },
      runtime,
      storage,
      usage: {
        byModel: overview.byModel,
        recentDaily: overview.recentDaily,
        trendNote: "Daily tokens are thread totals grouped by thread creation date, not billing usage.",
      },
      threads: overview.recentThreads,
      activity,
      logs,
      goals,
      health: { warnings: healthWarnings },
      privacy: {
        localServer: true,
        localCodexMetadataStaysLocal: true,
        readOnly: true,
        analytics: false,
        remoteAssets: false,
        externalInsights: "Codex Resets date range and optional Artificial Analysis API key only; no local Codex metadata is sent.",
        contentPolicy: "Xedoc reads only whitelisted metrics from recent rollout tails and never returns prompts, reasoning, commands, tool output, auth, or config contents.",
      },
      sources: [
        {
          name: "Thread index",
          status: paths.state ? "available" : "missing",
          path: describeDatabase(paths.state),
          stability: "Internal, versioned schema",
        },
        {
          name: "Structured logs",
          status: paths.logs ? "available" : "missing",
          path: describeDatabase(paths.logs),
          stability: "Internal, metadata only",
        },
        {
          name: "Goal accounting",
          status: paths.goals ? "available" : "missing",
          path: describeDatabase(paths.goals),
          stability: "Optional",
        },
        {
          name: "Recent rollout tail",
          status: activity.available ? "available" : "missing",
          path: null,
          stability: "Internal JSONL, bounded parser",
        },
        {
          name: "OS processes",
          status: runtime.supported ? "available" : "permission-limited",
          path: null,
          stability: "OS process-table sample",
        },
      ],
    };
  }

  async threads(options) {
    const paths = await this.databasePaths();
    if (!paths.state) return { data: [], total: 0, limit: options.limit, offset: options.offset, error: "State database unavailable." };
    try {
      return withReadonlyDatabase(paths.state, (database) => queryThreads(database, options));
    } catch {
      return { data: [], total: 0, limit: options.limit, offset: options.offset, error: "Thread index unavailable." };
    }
  }

  async activity(threadId) {
    const paths = await this.databasePaths();
    if (!paths.state) return { available: false, reason: "State database unavailable.", threadId };
    try {
      const candidate = withReadonlyDatabase(paths.state, (database) => queryThreadActivityCandidate(database, threadId));
      if (!candidate) return { available: false, reason: "Thread not found.", threadId };
      return this.recentActivity({ rolloutPath: candidate.rolloutPath, threadId, thread: candidate.thread });
    } catch {
      return { available: false, reason: "Thread activity metadata is unavailable.", threadId };
    }
  }

  async insights() {
    const resetsPromise = this.resetHistoryCache
      .get(() => collectResetHistory({ fetchImpl: this.fetchImpl }), {
        staleIfError: true,
        errorTtlMs: (error) => Math.max(60_000, Number(error?.retryAfterMs) || 0),
        fallbackOnError: (error) => ({
          available: false,
          fetchedAt: null,
          reason: publicExternalReason(error, "Codex reset history is temporarily unavailable."),
          items: [],
          count: null,
          source: "Codex Resets",
          sourceUrl: "https://codex-resets.com/",
        }),
      });
    const modelsPromise = this.modelPerformanceCache
      .get(() => collectArtificialAnalysisModels({
        apiKey: this.artificialAnalysisApiKey,
        fetchImpl: this.fetchImpl,
      }), {
        staleIfError: true,
        errorTtlMs: (error) => Math.max(5 * 60_000, Number(error?.retryAfterMs) || 0),
        fallbackOnError: (error) => ({
          available: false,
          configured: Boolean(this.artificialAnalysisApiKey),
          fetchedAt: null,
          reason: publicExternalReason(error, "Artificial Analysis data is temporarily unavailable."),
          models: [],
          count: null,
          source: "Artificial Analysis",
          sourceUrl: "https://artificialanalysis.ai/",
        }),
      });

    const [resets, models] = await Promise.all([resetsPromise, modelsPromise]);
    return {
      generatedAt: Date.now(),
      resets,
      models,
      network: {
        enabled: true,
        policy: "Fixed read-only providers, bounded responses, server-side caching, and no browser-visible API key.",
      },
    };
  }

  files(relativePath, options) {
    return listDirectory(this.codexHome, relativePath, options);
  }
}

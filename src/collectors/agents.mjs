import { collectRecentActivity } from "./activity.mjs";

const DEFAULT_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_TAIL_BYTES = 512 * 1024;

function safeLabel(value, maximum = 120) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1).trimEnd()}…` : normalized;
}

export async function collectRunningAgents(candidates, {
  codexHome,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxBytes = DEFAULT_TAIL_BYTES,
  concurrency = 4,
} = {}) {
  const selected = Array.isArray(candidates) ? candidates.slice(0, 64) : [];
  const results = new Array(selected.length);
  let cursor = 0;

  const inspectNext = async () => {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const candidate = selected[index];
      const activity = await collectRecentActivity({
        codexHome,
        rolloutPath: candidate.rolloutPath,
        maxBytes,
      });
      const lastObservedAt = Number(activity?.file?.modifiedAt);
      const recentlyObserved = Number.isFinite(lastObservedAt)
        && Math.max(0, now - lastObservedAt) <= maxAgeMs;
      if (!activity.available || activity.turns?.running !== true || !recentlyObserved) continue;
      results[index] = {
        id: String(candidate.id || "").slice(0, 200),
        kind: candidate.isSubagent ? "subagent" : "main",
        nickname: safeLabel(candidate.agentNickname, 80),
        role: safeLabel(candidate.agentRole, 80),
        model: safeLabel(candidate.model, 120) || "unknown",
        reasoningEffort: safeLabel(candidate.reasoningEffort, 40) || "unknown",
        project: safeLabel(candidate.cwd, 320),
        tokens: Number.isFinite(Number(candidate.tokens)) ? Number(candidate.tokens) : null,
        runningSince: Number.isFinite(Number(activity.turns.startedAt)) ? Number(activity.turns.startedAt) : null,
        lastObservedAt,
      };
    }
  };

  const workerCount = Math.max(1, Math.min(8, Number(concurrency) || 4, selected.length || 1));
  await Promise.all(Array.from({ length: workerCount }, inspectNext));
  const agents = results.filter(Boolean).sort((left, right) => (
    (left.kind === "main" ? 0 : 1) - (right.kind === "main" ? 0 : 1)
    || right.lastObservedAt - left.lastObservedAt
  ));
  return {
    agents,
    inspected: selected.length,
    maxAgeMs,
    tailBytes: maxBytes,
  };
}

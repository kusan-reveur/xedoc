const CODEX_RESETS_ENDPOINT = "https://codex-resets.com/api/v1/resets";
const ARTIFICIAL_ANALYSIS_ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models/free";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RESET_RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024;
const MODEL_RESPONSE_BUDGET_BYTES = 8 * 1024 * 1024;
const MAX_RESET_ITEMS = 500;
const MAX_MODEL_ITEMS = 1_000;
const REQUEST_TIMEOUT_MS = 8_000;
const COLLECTION_TIMEOUT_MS = 20_000;

function responseBudgetError() {
  const error = new Error("Remote response exceeded the safety limit.");
  error.code = "REMOTE_RESPONSE_BUDGET_EXCEEDED";
  return error;
}

function remainingTimeout(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("The remote API request timed out.");
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

function retryDelayMs(response) {
  const candidates = [];
  const retryAfter = String(response.headers?.get?.("retry-after") || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) candidates.push(Number(retryAfter) * 1_000);
  else if (retryAfter) candidates.push(Date.parse(retryAfter) - Date.now());
  const resetAt = Number(response.headers?.get?.("x-ratelimit-reset"));
  if (Number.isFinite(resetAt) && resetAt > 0) candidates.push(resetAt * 1_000 - Date.now());
  const delay = Math.max(0, ...candidates.filter(Number.isFinite));
  return Math.min(delay, 24 * 60 * 60_000);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortText(value, maximum = 400) {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > maximum ? `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…` : normalized;
}

function safeResetSource(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) return null;
    if (!/^\/thsottiaux\/status\/\d{1,32}\/?$/.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function boundedJson(response, maximumBytes = MAX_RESPONSE_BYTES, byteBudget = null) {
  const remainingBytes = Math.max(0, Number(byteBudget?.remaining ?? maximumBytes));
  const allowedBytes = Math.min(maximumBytes, remainingBytes);
  if (allowedBytes === 0) throw responseBudgetError();
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > allowedBytes) {
    throw responseBudgetError();
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > allowedBytes) throw responseBudgetError();
    if (byteBudget) byteBudget.remaining -= buffer.byteLength;
    try {
      return JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      throw new Error("The remote API returned invalid JSON.");
    }
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > allowedBytes) {
      await reader.cancel();
      throw responseBudgetError();
    }
    chunks.push(value);
  }
  if (byteBudget) byteBudget.remaining -= total;
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error("The remote API returned invalid JSON.");
  }
}

async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  byteBudget = null,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Network requests are unavailable in this Node runtime.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("The remote API rejected its credentials.");
      if (response.status === 429) {
        const error = new Error("The remote API rate limit was reached.");
        error.retryAfterMs = retryDelayMs(response);
        throw error;
      }
      throw new Error(`The remote API returned HTTP ${response.status}.`);
    }
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json") && !contentType.includes("application/problem+json")) {
      throw new Error("The remote API returned an unexpected content type.");
    }
    return boundedJson(response, MAX_RESPONSE_BYTES, byteBudget);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The remote API request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseResetHistory(payload, { from, to } = {}) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const resets = items
    .map((item) => {
      const announcedAt = Date.parse(item?.announced_at);
      if (!Number.isFinite(announcedAt)) return null;
      if (Number.isFinite(start) && announcedAt < start) return null;
      if (Number.isFinite(end) && announcedAt > end) return null;
      const id = /^\d{1,32}$/.test(String(item?.id || "")) ? String(item.id) : null;
      const sourceUrl = safeResetSource(item?.source?.url);
      return {
        id,
        announcedAt: new Date(announcedAt).toISOString(),
        text: shortText(item?.text, 600),
        sourceUrl,
      };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.announcedAt) - Date.parse(left.announcedAt));

  const intervals = [];
  for (let index = 1; index < resets.length; index += 1) {
    intervals.push((Date.parse(resets[index - 1].announcedAt) - Date.parse(resets[index].announcedAt)) / 86_400_000);
  }
  return {
    available: true,
    from,
    to,
    count: resets.length,
    averageIntervalDays: intervals.length
      ? intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length
      : null,
    latestAt: resets[0]?.announcedAt || null,
    items: resets,
    limited: Boolean(payload?.pagination?.has_more),
    generatedAt: typeof payload?.meta?.generated_at === "string" ? payload.meta.generated_at : null,
    source: "Codex Resets",
    sourceUrl: "https://codex-resets.com/",
  };
}

export async function collectResetHistory({ fetchImpl = globalThis.fetch, now = Date.now(), days = 30 } = {}) {
  const deadline = Date.now() + COLLECTION_TIMEOUT_MS;
  const byteBudget = { remaining: RESET_RESPONSE_BUDGET_BYTES };
  const to = new Date(now).toISOString();
  const from = new Date(now - days * 86_400_000).toISOString();
  const url = new URL(CODEX_RESETS_ENDPOINT);
  url.searchParams.set("limit", "100");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("order", "desc");
  const payload = await fetchJson(url, { fetchImpl, timeoutMs: remainingTimeout(deadline), byteBudget });
  const firstItems = Array.isArray(payload?.data) ? payload.data : [];
  const combined = {
    ...payload,
    data: firstItems.slice(0, MAX_RESET_ITEMS),
  };
  let pagination = payload?.pagination;
  let cursor = pagination?.next_cursor;
  let pageCount = 1;
  let limited = firstItems.length > combined.data.length;
  while (!limited && pagination?.has_more && cursor && pageCount < 5) {
    if (byteBudget.remaining <= 0 || combined.data.length >= MAX_RESET_ITEMS) {
      limited = true;
      break;
    }
    url.searchParams.set("cursor", String(cursor));
    let page;
    try {
      page = await fetchJson(url, { fetchImpl, timeoutMs: remainingTimeout(deadline), byteBudget });
    } catch (error) {
      if (error?.code !== "REMOTE_RESPONSE_BUDGET_EXCEEDED") throw error;
      limited = true;
      break;
    }
    const pageItems = Array.isArray(page?.data) ? page.data : [];
    const remainingItems = MAX_RESET_ITEMS - combined.data.length;
    combined.data.push(...pageItems.slice(0, remainingItems));
    if (pageItems.length > remainingItems) limited = true;
    pagination = page?.pagination;
    cursor = pagination?.next_cursor;
    pageCount += 1;
    if (!pagination?.has_more) break;
  }
  if (pagination?.has_more && (!cursor || pageCount >= 5)) limited = true;
  combined.pagination = { ...pagination, has_more: limited || Boolean(pagination?.has_more) };
  return { ...parseResetHistory(combined, { from, to }), fetchedAt: Date.now() };
}

function isCodexRelevantOpenAiModel(item) {
  const creatorName = String(item?.model_creator?.name || "").trim().toLowerCase();
  const creatorSlug = String(item?.model_creator?.slug || "").trim().toLowerCase();
  const model = `${item?.name || ""} ${item?.slug || ""}`.toLowerCase();
  return (creatorName === "openai" || creatorSlug === "openai")
    && /\b(?:codex|sol|terra|luna)\b/.test(model);
}

export function parseArtificialAnalysisModels(payload) {
  const sourceItems = Array.isArray(payload?.data) ? payload.data : [];
  const matchingModels = sourceItems
    .filter(isCodexRelevantOpenAiModel)
    .map((item) => ({
      id: shortText(item?.id, 120),
      name: shortText(item?.name, 160) || "Unnamed Codex model",
      slug: shortText(item?.slug, 180),
      codingIndex: finiteNumber(item?.evaluations?.artificial_analysis_coding_index),
      intelligenceIndex: finiteNumber(item?.evaluations?.artificial_analysis_intelligence_index),
      agenticIndex: finiteNumber(item?.evaluations?.artificial_analysis_agentic_index),
      costPerTask: finiteNumber(item?.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost),
      blendedPricePerMillion: finiteNumber(item?.pricing?.price_1m_blended_3_to_1),
      inputPricePerMillion: finiteNumber(item?.pricing?.price_1m_input_tokens),
      outputPricePerMillion: finiteNumber(item?.pricing?.price_1m_output_tokens),
      outputTokensPerSecond: finiteNumber(item?.performance?.median_output_tokens_per_second ?? item?.median_output_tokens_per_second),
      timeToFirstTokenSeconds: finiteNumber(item?.performance?.median_time_to_first_token_seconds ?? item?.median_time_to_first_token_seconds),
      endToEndSeconds: finiteNumber(item?.performance?.median_end_to_end_response_time_seconds),
    }))
    .sort((left, right) => (right.codingIndex ?? -Infinity) - (left.codingIndex ?? -Infinity));
  const models = matchingModels.slice(0, 30);

  return {
    available: true,
    configured: true,
    models,
    count: matchingModels.length,
    displayedCount: models.length,
    limited: Boolean(payload?.limited) || matchingModels.length > models.length,
    promptLength: shortText(payload?.prompt_options?.prompt_length, 40) || null,
    intelligenceIndexVersion: finiteNumber(payload?.intelligence_index_version),
    source: "Artificial Analysis",
    sourceUrl: "https://artificialanalysis.ai/",
    methodologyUrl: "https://artificialanalysis.ai/methodology",
  };
}

export async function collectArtificialAnalysisModels({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) {
    return {
      available: false,
      configured: false,
      fetchedAt: null,
      reason: "Set ARTIFICIAL_ANALYSIS_API_KEY before launching Xedoc to load free API data.",
      models: [],
      count: 0,
      source: "Artificial Analysis",
      sourceUrl: "https://artificialanalysis.ai/",
    };
  }
  const deadline = Date.now() + COLLECTION_TIMEOUT_MS;
  const byteBudget = { remaining: MODEL_RESPONSE_BUDGET_BYTES };
  const url = new URL(ARTIFICIAL_ANALYSIS_ENDPOINT);
  const combined = { data: [] };
  let hasMore = false;
  let limited = false;
  for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
    if (byteBudget.remaining <= 0 || combined.data.length >= MAX_MODEL_ITEMS) {
      limited = true;
      break;
    }
    url.searchParams.set("page", String(pageNumber));
    let page;
    try {
      page = await fetchJson(url, {
        fetchImpl,
        headers: { "x-api-key": String(apiKey) },
        timeoutMs: remainingTimeout(deadline),
        byteBudget,
      });
    } catch (error) {
      if (error?.code !== "REMOTE_RESPONSE_BUDGET_EXCEEDED" || pageNumber === 1) throw error;
      limited = true;
      break;
    }
    const pageItems = Array.isArray(page?.data) ? page.data : [];
    const remainingItems = MAX_MODEL_ITEMS - combined.data.length;
    combined.data.push(...pageItems.slice(0, remainingItems));
    if (pageItems.length > remainingItems) limited = true;
    if (combined.intelligence_index_version === undefined) {
      combined.intelligence_index_version = page?.intelligence_index_version;
    }
    hasMore = Boolean(page?.pagination?.has_more);
    if (!hasMore || limited) break;
  }
  combined.limited = limited || hasMore;
  return { ...parseArtificialAnalysisModels(combined), fetchedAt: Date.now() };
}

export const EXTERNAL_ENDPOINTS = {
  codexResets: CODEX_RESETS_ENDPOINT,
  artificialAnalysis: ARTIFICIAL_ANALYSIS_ENDPOINT,
};

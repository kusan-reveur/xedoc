import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);

export function childEnvironment(source = process.env, additions = {}) {
  return { ...source, ...additions };
}

export async function runFile(command, args = [], options = {}) {
  const environment = childEnvironment(options.env || process.env);
  return execFilePromise(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
    ...options,
    env: environment,
  });
}

export function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : Number.MAX_SAFE_INTEGER;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

export function parseElapsed(value) {
  const match = String(value).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return 0;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveContainedPath(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!isInside(absoluteRoot, absoluteCandidate)) throw new Error("Path escapes its scope");

  const [realRoot, realCandidate] = await Promise.all([
    fs.realpath(absoluteRoot),
    fs.realpath(absoluteCandidate),
  ]);
  if (!isInside(realRoot, realCandidate)) throw new Error("Path resolves outside its scope");
  return realCandidate;
}

export async function canonicalPathsOverlap(left, right) {
  const [realLeft, realRight] = await Promise.all([
    fs.realpath(path.resolve(left)),
    fs.realpath(path.resolve(right)),
  ]);
  return isInside(realLeft, realRight) || isInside(realRight, realLeft);
}

export async function resolveSafeChild(root, relativePath = "") {
  if (relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid path");
  }

  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath || ".");
  if (!isInside(absoluteRoot, target)) throw new Error("Path escapes its scope");

  const relative = path.relative(absoluteRoot, target);
  let cursor = absoluteRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await fs.lstat(cursor);
    if (info.isSymbolicLink()) throw new Error("Symbolic links are not browsable");
  }
  return target;
}

export function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

export function isSensitivePath(value) {
  const normalized = value.split(path.sep).join("/").toLowerCase();
  return /(^|\/)(auth\.json|credentials?(\.json)?|secrets?|config\.toml|.*\.key|.*\.pem)$/.test(normalized);
}

export function publicError(error, fallback) {
  if (error?.code === "ENOENT") return "Not found";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "Permission denied";
  return fallback;
}

export class TtlCache {
  #expiresAt = 0;
  #pending = null;
  #value;

  constructor(ttlMs) {
    this.ttlMs = ttlMs;
  }

  async get(factory, {
    force = false,
    staleIfError = false,
    errorTtlMs = 0,
    fallbackOnError = null,
  } = {}) {
    const now = Date.now();
    if (!force && this.#value !== undefined && now < this.#expiresAt) return this.#value;
    if (this.#pending) return this.#pending;
    const previousValue = this.#value;

    this.#pending = Promise.resolve()
      .then(factory)
      .then((value) => {
        this.#value = value;
        this.#expiresAt = Date.now() + this.ttlMs;
        return value;
      })
      .catch((error) => {
        const errorTtl = typeof errorTtlMs === "function" ? errorTtlMs(error) : errorTtlMs;
        const retryAt = Date.now() + Math.max(0, Number(errorTtl) || 0);
        if (staleIfError && previousValue !== undefined) {
          this.#expiresAt = retryAt;
          return previousValue;
        }
        if (typeof fallbackOnError === "function") {
          const value = fallbackOnError(error);
          this.#value = value;
          this.#expiresAt = retryAt;
          return value;
        }
        throw error;
      })
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }
}

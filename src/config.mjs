import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 47831;

export function resolveCodexHome(value = process.env.CODEX_HOME) {
  return path.resolve(value || path.join(os.homedir(), ".codex"));
}

export function resolveSqliteHome(codexHome, value = process.env.CODEX_SQLITE_HOME) {
  return path.resolve(value || codexHome);
}

export function isLoopbackHost(host) {
  const normalized = normalizeLoopbackHost(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function normalizeLoopbackHost(host) {
  const normalized = String(host).trim().replace(/^\[|\]$/g, "");
  return normalized.toLowerCase() === "localhost" ? DEFAULT_HOST : normalized;
}

export function displayPath(value) {
  if (!value) return "";
  const absolute = path.resolve(value);
  const home = os.homedir();
  if (absolute === home) return "~";
  if (absolute.startsWith(`${home}${path.sep}`)) {
    return `~${absolute.slice(home.length)}`;
  }
  return absolute;
}

export function parseArgs(argv) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    codexHome: resolveCodexHome(),
    sqliteHome: null,
    open: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`Missing value after ${argument}`);
      return argv[index];
    };

    if (argument === "--host") options.host = next();
    else if (argument === "--port") options.port = Number(next());
    else if (argument === "--codex-home") options.codexHome = resolveCodexHome(next());
    else if (argument === "--sqlite-home") options.sqliteHome = path.resolve(next());
    else if (argument === "--open") options.open = true;
    else if (argument === "--no-open") options.open = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (!isLoopbackHost(options.host)) {
    throw new Error("Xedoc is local-only. --host must be 127.0.0.1, ::1, or localhost.");
  }
  options.host = normalizeLoopbackHost(options.host);
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }

  options.sqliteHome = resolveSqliteHome(options.codexHome, options.sqliteHome || undefined);

  return options;
}

export const HELP = `Xedoc — Codex, in plain sight.

Usage: xedoc [options]

Options:
  --host <loopback>    Bind address (default: 127.0.0.1)
  --port <number>      Port (default: 47831; use 0 for an available port)
  --codex-home <path>  Codex state directory (default: CODEX_HOME or ~/.codex)
  --sqlite-home <path> SQLite state directory (default: CODEX_SQLITE_HOME or CODEX_HOME)
  --open               Open the dashboard in the default browser (default)
  --no-open            Print the dashboard URL without opening it
  -h, --help           Show this help
`;

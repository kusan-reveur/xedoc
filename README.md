# Xedoc

**Codex, in plain sight.** Xedoc is a private, local-only dashboard for inspecting the disk, process, token, timing, and health metadata that Codex leaves on your machine.

## What it shows

- Codex/ChatGPT process count, OS-reported CPU, aggregate RSS, and uptime
- Strict Codex-worker memory separately from the wider host-app process family
- Thread counts, models, reasoning effort, source, timestamps, lifespan, and recorded tokens
- Token breakdown for the most recently active rollout, including cached and reasoning tokens
- Exact recent turn runtime and median time-to-first-token when those events are available
- Storage grouped into conversation history, logs, indexes, extensions, artifacts, caches, and runtime state
- The largest indexed rollout files (bounded to recent candidates), app caches/logs, and same-user Codex-like entries in the system temp directory
- A safe, lazy file browser for metadata under `CODEX_HOME`
- Warning/error counts and targets from structured logs without log bodies
- Goal token/time accounting when explicit Codex goals exist

Xedoc deliberately does **not** estimate dollar cost. Local ChatGPT/Codex subscription token activity is not equivalent to API billing.

## Run it

Xedoc needs Node.js 22.16 or newer and has no package dependencies.

```bash
node src/cli.mjs
```

Then open the full loopback URL printed by Xedoc, including its secret `#token=…` fragment. The fragment is not sent in HTTP requests; the dashboard keeps it only in the browser session. To open it automatically:

```bash
node src/cli.mjs --open
```

On a shared machine, prefer copying the printed URL yourself: `--open` briefly places the secret URL in the platform launcher command line.

Useful options:

```text
--port 0                 choose an available local port
--codex-home /path       override CODEX_HOME
--sqlite-home /path      override CODEX_SQLITE_HOME
```

The server rejects non-loopback bind addresses.

## Privacy and safety model

Xedoc is read-only by design:

- binds only to `127.0.0.1`, `::1`, or `localhost`;
- protects every metadata API with a random token delivered only in the CLI URL fragment and retained in browser session storage;
- validates Host and Origin headers and sends a restrictive Content Security Policy;
- contains no analytics, remote assets, package dependencies, or outgoing requests;
- opens Codex SQLite databases in read-only/query-only mode;
- never offers delete, cleanup, archive, or configuration actions;
- never returns auth/config contents, prompts, reasoning, commands, patches, tool output, log bodies, attachments, or browser data;
- only parses one bounded selected/recent rollout tail at a time and whitelists known numeric/status fields;
- refuses to browse through symbolic links.

Paths, filenames, thread IDs, process names, and repository locations are still metadata and may be sensitive. Treat screenshots and screen sharing accordingly.

The unauthenticated loopback root serves only the static dashboard shell. A local process or another OS account still needs the secret URL fragment to query metadata; anyone who can read your terminal output or browser session should be treated as authorized while Xedoc is running.

## Why the scanner is bounded

Rollout JSONL files can be several gigabytes, and content-heavy compaction records can be tens of megabytes per line. Xedoc therefore uses the versioned state database as a fast index, gathers file sizes from filesystem metadata, and reads at most a small tail of one selected or recent rollout at a time. It never rescans all conversation contents on refresh.

Conversation rollouts are persistent chat history, **not ordinary disposable temporary files**. Xedoc labels caches and temporary candidates separately and does not imply that history is safe to remove.

## Data sources

Xedoc discovers these sources rather than assuming a fixed version suffix:

- `CODEX_HOME` (normally `~/.codex`) for sessions, archives, logs, artifacts, plugins, packages, and cache state
- the newest compatible `state_*.sqlite`, `logs_*.sqlite`, and optional `goals_*.sqlite`
- a selected or newest rollout path indexed by the state database
- OS process tables and open-file metadata where permissions allow
- macOS Codex app support, cache, update-cache, log, and HTTP-storage directories
- Codex/OpenAI-named entries directly under known system temp roots

OpenAI documents `CODEX_HOME`, `CODEX_SQLITE_HOME`, local session persistence, logs, and opt-in OpenTelemetry in the [Codex environment-variable](https://learn.chatgpt.com/docs/config-file/environment-variables) and [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) documentation. The numbered SQLite schemas and rollout record shapes used for richer local metadata are internal and may change; Xedoc fails individual panels independently when a schema is unavailable.

## Metric caveats

- Aggregate RSS can count shared Electron memory more than once.
- CPU is the OS process table's reported percentage (its averaging window varies by platform) and can exceed 100% across multiple cores.
- Process uptime is not developer working time.
- Thread lifespan includes idle time.
- Recent exact runtime covers only completed turn events found in the bounded rollout tail.
- Daily token bars assign a thread's current total to its creation date; they are not billing or a precise daily consumption ledger.
- Cached input and reasoning output are subsets and are not added on top of total tokens.
- Live Codex files can move, grow, archive, or disappear during a scan; Xedoc treats those races as normal.
- Safety budgets cap top-level, temporary, open-file, directory-browser, and rollout-candidate scans; the dashboard marks partial counts with `+` and partial byte totals as lower bounds.

Full process and disk-size collection currently targets macOS and Linux. On Windows, those collectors report unavailable rather than inventing totals; the metadata browser remains read-only and usable where the state schema is compatible.

## Development

```bash
node --test
node --check public/app.js
```

Or, if pnpm is available:

```bash
pnpm check
pnpm dev
```

The server and collectors use Node built-ins only. Tests cover privacy-safe JSONL parsing, read-only metadata queries, process-tree attribution, path containment/symlink rejection, and API session-token protection.

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Metric, MetricId, Unavailable } from "../shared/metrics.ts";
import { projectCodex } from "./usage.ts";

const ids = ["input", "output", "cache", "compactions"] as const;
const headerBudget = 64 * 1024;
const tailBudget = 2 * 1024 * 1024;
const metadataBudget = 32 * 1024;
const rolloutPrefix = /^\{"timestamp":"[^"\\]{1,80}",(?:"ordinal":\d+,)?"type":"([a-z_]+)","payload":/;
const sessionIdentity = /^\{(?:"(?:account_scoped|creator_user_id|creator_account_id)":(?:true|false|null|"[^"\\]{0,128}"),)*"(?:id|session_id)":"([a-zA-Z0-9_-]{1,128})"(?:(?:,"(?:id|session_id)":"([a-zA-Z0-9_-]{1,128})")|(?=,|}))/;
type Projection = Partial<Record<MetricId, Metric>>;

function unavailable(state: Unavailable): Projection {
  return Object.fromEntries(ids.map(id => [id, { state, source: "codex" }]));
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Extracts a primitive field from a top-level payload without decoding nested compaction text. */
function compactWindow(line: string): number | undefined {
  const start = line.indexOf('"type":"compacted","payload":{');
  if (start === -1) return undefined;
  let depth = 0;
  const payload = line.slice(start + '"type":"compacted","payload":'.length);
  for (let i = 0; i < payload.length; i++) {
    const char = payload[i];
    const key = '"window_number":';
    if (char === '"' && depth === 1 && payload.startsWith(key, i)) {
      const start = i + key.length;
      const literal = /^\s*(\d+)(?=\s*[,}])/.exec(payload.slice(start, start + 32));
      return literal ? Number(literal[1]) : undefined;
    }
    if (char === '"') {
      for (++i; i < payload.length; i++) {
        if (payload[i] === "\\") i++;
        else if (payload[i] === '"') break;
      }
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  return undefined;
}

export async function readCodex(codexHome: string, threadId: string | null, signal: AbortSignal): Promise<Projection> {
  if (!threadId) return unavailable("waiting");
  if (!isAbsolute(codexHome)) return unavailable("unsupported");
  try {
    if (signal.aborted) return unavailable("error");
    const home = await realpath(codexHome);
    const index = await realpath(join(home, "state_5.sqlite"));
    if (!isInside(home, index)) return unavailable("forbidden");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(index, { readOnly: true, timeout: 150 });
    let indexedPath: unknown;
    try {
      indexedPath = db.prepare("SELECT rollout_path FROM threads WHERE id = ? AND archived = 0").get(threadId)?.rollout_path;
    } finally { db.close(); }
    if (typeof indexedPath !== "string" || !isAbsolute(indexedPath)) return unavailable("unlinked");
    const sessions = await realpath(join(home, "sessions"));
    const recording = await realpath(indexedPath);
    if (!isInside(home, sessions) || !isInside(sessions, recording)) return unavailable("forbidden");

    const file = await open(recording, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await file.stat();
      if (!stats.isFile()) return unavailable("unsupported");
      const header = Buffer.alloc(Math.min(headerBudget, stats.size));
      const head = await file.read(header, 0, header.length, 0);
      const newline = header.subarray(0, head.bytesRead).indexOf(10);
      if (newline < 0) return unavailable("waiting");
      const first = header.subarray(0, Math.min(newline, 768)).toString("utf8");
      const meta = rolloutPrefix.exec(first);
      const id = meta?.[1] === "session_meta" ? sessionIdentity.exec(first.slice(meta[0].length)) : null;
      if (id?.[1] !== threadId || (id[2] !== undefined && id[2] !== threadId)) return unavailable("unlinked");

      if (signal.aborted) return unavailable("error");
      // shortcut: bounded tail without a persisted cursor, widen only after measuring long-session coverage.
      const offset = Math.max(newline + 1, stats.size - tailBudget);
      const tail = Buffer.alloc(stats.size - offset);
      const read = await file.read(tail, 0, tail.length, offset);
      if (signal.aborted) return unavailable("error");
      const last = await file.stat();
      if (last.size < stats.size || read.bytesRead !== tail.length) return unavailable("waiting");
      let complete = offset === newline + 1 && last.size === stats.size;
      let usage: unknown;
      let compactionWindow: number | undefined = complete ? 0 : undefined;
      let compactionUnknown = false;
      let cursor = offset === newline + 1 ? 0 : tail.indexOf(10) + 1;
      if (offset > newline + 1 && cursor === 0) return unavailable("no-records");
      for (let end; (end = tail.indexOf(10, cursor)) !== -1; cursor = end + 1) {
        const buffer = tail.subarray(cursor, end);
        const prefix = buffer.subarray(0, 256).toString("utf8");
        const kind = rolloutPrefix.exec(prefix)?.[1];
        if (!kind) { complete = false; compactionUnknown = true; continue; }
        if (kind === "compacted") {
          const window = compactWindow(buffer.toString("utf8"));
          if (window === undefined || !Number.isSafeInteger(window) || window < 1) compactionUnknown = true;
          else compactionWindow = Math.max(compactionWindow ?? 0, window);
          continue;
        }
        if (kind !== "event_msg") continue;
        if (prefix.includes('"payload":{"type":"thread_rolled_back"')) {
          complete = false;
          compactionUnknown = true;
          usage = undefined;
          continue;
        }
        if (!prefix.includes('"payload":{"type":"token_count"')) continue;
        if (buffer.length > metadataBudget) { complete = false; usage = undefined; continue; }
        try {
          const record = JSON.parse(buffer.toString("utf8"));
          const total = record.payload?.info?.total_token_usage;
          if (total !== undefined) usage = total;
        } catch { complete = false; usage = undefined; }
      }
      if (cursor < tail.length) complete = false;
      return projectCodex({ threadId, complete, usage, compactionWindow: compactionUnknown ? undefined : compactionWindow }, threadId, Date.now());
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return unavailable("unsupported");
      if (error.code === "EACCES" || error.code === "EPERM") return unavailable("forbidden");
    }
    return unavailable("error");
  }
}

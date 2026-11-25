import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Metric, MetricId, Unavailable } from "../shared/metrics.ts";
import { projectCodex } from "./usage.ts";

const ids = ["input", "output", "cachedInput", "cache", "compactions"] as const;
const headerBudget = 64 * 1024;
const tailBudget = 2 * 1024 * 1024;
const historyChunkBytes = 8 * 1024 * 1024;
const historyReadBudget = 64 * 1024 * 1024;
const metadataBudget = 32 * 1024;
const rolloutPrefix = /^\{"timestamp":"(?<time>[^"\\]{1,80})",(?:"ordinal":\d+,)?"type":"(?<kind>[a-z_]+)","payload":/;
const sessionIdentity = /^\{(?:"(?:account_scoped|creator_user_id|creator_account_id)":(?:true|false|null|"[^"\\]{0,128}"),)*"(?:id|session_id)":"([a-zA-Z0-9_-]{1,128})"(?:(?:,"(?:id|session_id)":"([a-zA-Z0-9_-]{1,128})")|(?=,|}))/;
type Projection = Partial<Record<MetricId, Metric>>;
type Scan = {
  usage?: { input_tokens: unknown; output_tokens: unknown; cached_input_tokens: unknown };
  usageAt?: number;
  compactionAt?: number;
  compactionWindow?: number;
  compactionUnknown?: boolean;
};
type Checkpoint = {
  fileId: string;
  size: number;
  modified: number;
  changed: number;
  offset: number;
  boundary: string;
  state: Scan;
};
const checkpoints = new Map<string, Checkpoint>();
const boundaryBytes = 256;
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

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

function scanRecords(bytes: Buffer, cursor: number, state: Scan): number {
  for (let end; (end = bytes.indexOf(10, cursor)) !== -1; cursor = end + 1) {
    const buffer = bytes.subarray(cursor, end);
    const prefix = buffer.subarray(0, 256).toString("utf8");
    const recordPrefix = rolloutPrefix.exec(prefix)?.groups;
    if (!recordPrefix) { state.compactionUnknown = true; state.usage = undefined; continue; }
    const { kind, time } = recordPrefix;
    if (kind === "compacted") {
      const window = compactWindow(buffer.toString("utf8"));
      if (window === undefined || !Number.isSafeInteger(window) || window < 1) state.compactionUnknown = true;
      else if (state.compactionWindow !== undefined &&
        (window < state.compactionWindow || window > state.compactionWindow + 1)) state.compactionUnknown = true;
      else {
        state.compactionWindow = window;
        state.compactionAt = timestamp(time);
      }
      continue;
    }
    if (kind !== "event_msg") continue;
    if (prefix.includes('"payload":{"type":"thread_rolled_back"')) {
      state.compactionUnknown = true;
      state.usage = undefined;
      continue;
    }
    if (!prefix.includes('"payload":{"type":"token_count"')) continue;
    if (buffer.length > metadataBudget) { state.usage = undefined; continue; }
    try {
      const record = JSON.parse(buffer.toString("utf8"));
      const total = record.payload?.info?.total_token_usage;
      if (total && typeof total === "object") {
        state.usage = {
          input_tokens: total.input_tokens, output_tokens: total.output_tokens,
          cached_input_tokens: total.cached_input_tokens,
        };
        if (Object.values(state.usage).some(value => typeof value !== "number")) state.usage = undefined;
        state.usageAt = timestamp(record.timestamp);
      } else if (total !== undefined) {
        state.usage = undefined;
      }
    } catch { state.usage = undefined; }
  }
  return cursor;
}

function timestamp(value: unknown): number | undefined {
  const stamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) && stamp >= 0 ? stamp : undefined;
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
      const id = meta?.groups?.kind === "session_meta" ? sessionIdentity.exec(first.slice(meta[0].length)) : null;
      if (id?.[1] !== threadId || (id[2] !== undefined && id[2] !== threadId)) return unavailable("unlinked");

      const key = JSON.stringify([home, threadId, recording]);
      const fileId = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}:${digest(header.subarray(0, newline))}`;
      async function readAt(offset: number, length: number) {
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await file.read(bytes, 0, length, offset);
        return bytesRead === length ? bytes : null;
      }
      async function boundaryAt(offset: number) {
        const start = Math.max(0, offset - boundaryBytes);
        const bytes = await readAt(start, offset - start);
        return bytes && digest(bytes);
      }
      const previous = checkpoints.get(key);
      const resume = previous && previous.fileId === fileId && previous.size <= stats.size &&
        previous.modified <= stats.mtimeMs &&
        (previous.size !== stats.size || (previous.modified === stats.mtimeMs && previous.changed === stats.ctimeMs)) &&
        previous.boundary === await boundaryAt(previous.offset);
      const state = resume ? { ...previous.state } : {};
      let verifiedOffset = resume ? previous.offset : newline + 1;
      let remaining = historyReadBudget;
      let reachedEnd = verifiedOffset === stats.size;
      while (!reachedEnd && remaining > 0) {
        if (signal.aborted) return unavailable("error");
        const length = Math.min(stats.size - verifiedOffset, historyChunkBytes, remaining);
        const bytes = await readAt(verifiedOffset, length);
        if (!bytes) return unavailable("waiting");
        remaining -= length;
        reachedEnd = verifiedOffset + length === stats.size;
        const consumed = scanRecords(bytes, 0, state);
        // shortcut: a record larger than one chunk stalls history verification; stream the record if observed.
        if (consumed === 0) break;
        verifiedOffset += consumed;
      }
      let usage = state.usage;
      let usageAt = state.usageAt;
      if (!reachedEnd) {
        // Keep cumulative token readings useful while the earlier history catches up.
        const start = Math.max(newline + 1, stats.size - tailBudget);
        const tail = await readAt(start, stats.size - start);
        if (!tail) return unavailable("waiting");
        const tailState: Scan = {};
        const firstComplete = start === newline + 1 ? 0 : tail.indexOf(10) + 1;
        if (start === newline + 1 || firstComplete > 0) scanRecords(tail, firstComplete, tailState);
        ({ usage, usageAt } = tailState);
      }
      const boundary = await boundaryAt(verifiedOffset);
      const last = await file.stat();
      if (signal.aborted) return unavailable("error");
      if (!boundary || last.size < stats.size ||
        (last.size === stats.size && (last.mtimeMs !== stats.mtimeMs || last.ctimeMs !== stats.ctimeMs))) {
        return unavailable("waiting");
      }
      if (checkpoints.get(key) === previous) {
        checkpoints.delete(key);
        if (checkpoints.size >= 32) checkpoints.delete(checkpoints.keys().next().value!);
        checkpoints.set(key, { fileId, offset: verifiedOffset, size: stats.size,
          modified: stats.mtimeMs, changed: stats.ctimeMs, boundary, state });
      }
      const result = projectCodex({
        threadId, usage, usageAt, compactionAt: state.compactionAt,
        compactionWindow: reachedEnd && !state.compactionUnknown
          ? state.compactionWindow ?? (verifiedOffset === stats.size && last.size === stats.size ? 0 : undefined)
          : undefined,
      }, threadId, Date.now());
      if (!reachedEnd && !state.compactionUnknown) {
        result.compactions = { state: "waiting", source: "codex", basis: "压缩历史待续读" };
      }
      return result;
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return unavailable("unsupported");
      if (error.code === "EACCES" || error.code === "EPERM") return unavailable("forbidden");
    }
    return unavailable("error");
  }
}

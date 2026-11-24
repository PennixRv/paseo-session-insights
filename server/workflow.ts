import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { detailGroups, type Metric, type MetricId } from "../shared/metrics.ts";

type Projection = Partial<Record<MetricId, Metric>>;
type RunJson = (args: string[], cwd: string, ms: number) => Promise<unknown>;
const counts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const progress = z.object({ planning: counts, in_progress: counts, completed: counts, cancelled: counts.optional(), partial: z.boolean().optional() });
const channel = z.object({ name: z.string().regex(/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,127}$/),
  project: z.string().min(1).max(512).optional(), ownerSessionId: z.string() });
const worker = z.object({ workerId: z.string().min(1), lifecycle: z.string(), activity: z.string().optional(), updatedAt: z.string().optional() });
const tasks = detailGroups[2].ids;
const members = ["working", "idle", "error", "ended"] as const;

function unavailable(ids: readonly MetricId[], state: "unsupported" | "waiting" | "error"): Projection {
  return Object.fromEntries(ids.map(id => [id, { state }]));
}

function list(value: unknown) {
  return z.union([z.array(z.unknown()), z.object({ items: z.array(z.unknown()) })]).transform(
    value => Array.isArray(value) ? value : value.items,
  ).parse(value);
}

export function runTrellis(args: string[], cwd: string, timeout: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile("trellis", args, { cwd, timeout, signal, maxBuffer: 256 * 1024, shell: false }, (error, text) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(text)); } catch { reject(new Error("Trellis returned invalid JSON")); }
    });
  });
}

export async function readProgress(cwd: string | null, run: RunJson, clock = Date.now): Promise<Projection> {
  if (!cwd || !isAbsolute(cwd)) return unavailable(tasks, "unsupported");
  try {
    if (!(await stat(join(cwd, ".trellis", "tasks"))).isDirectory()) return unavailable(tasks, "unsupported");
    const data = progress.parse(await run(["task", "progress", "--json"], cwd, 2000));
    const observedAt = clock();
    const values = { planning: data.planning, inProgress: data.in_progress, completed: data.completed, cancelled: data.cancelled };
    return Object.fromEntries(tasks.map(id => {
      const value = values[id];
      const reading: Metric = value === undefined
        ? { state: "unsupported", source: "trellis", observedAt, basis: "当前 Trellis 未提供取消计数" }
        : { state: data.partial ? "partial" : "ready", source: "trellis", observedAt, value };
      return [id, reading];
    }));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return unavailable(tasks, "unsupported");
    return unavailable(tasks, "error");
  }
}

export async function readTeamwork(cwd: string | null, threadId: string | null, run: RunJson, clock = Date.now): Promise<Projection> {
  if (!cwd || !isAbsolute(cwd)) return unavailable(members, "unsupported");
  if (!threadId) return unavailable(members, "waiting");
  const deadline = clock() + 2500;
  const remaining = () => Math.max(1, deadline - clock());
  const scopes = ["project", "global"] as const;
  const responses = await Promise.allSettled(scopes.map(async scope =>
    list(await run(["teamwork", "list", "--scope", scope, "--all", "--owner-session", threadId, "--json"], cwd, remaining())),
  ));
  if (responses.every(r => r.status === "rejected")) return unavailable(members, "error");
  let partial = false;
  let successes = 0;
  const channels = new Set<string>();
  const tally = { working: 0, idle: 0, error: 0, ended: 0 };
  const sampleTime = clock();
  for (const [index, result] of responses.entries()) {
    const scope = scopes[index];
    if (result.status === "rejected") { partial = true; continue; }
    for (const raw of result.value) {
      const entry = channel.safeParse(raw);
      if (!entry.success || (scope === "project" && !entry.data.project)) { partial = true; continue; }
      const { project, name, ownerSessionId } = entry.data;
      if (ownerSessionId !== threadId) { partial = true; continue; }
      const id = JSON.stringify([scope, project, name]);
      if (channels.has(id)) continue;
      if (channels.size === 8 || clock() >= deadline) { partial = true; break; }
      channels.add(id);
      try {
        const args = ["teamwork", "workers", name, "--include-terminal", "--scope", scope, "--json"];
        if (scope === "project" && project) args.push("--project-key", project);
        const workers = list(await run(args, cwd, remaining()));
        const seen = new Set<string>();
        for (const rawWorker of workers) {
          const parsed = worker.safeParse(rawWorker);
          if (!parsed.success) { partial = true; continue; }
          const member = parsed.data;
          if (seen.has(member.workerId)) continue;
          seen.add(member.workerId);
          if (member.lifecycle === "starting" || member.lifecycle === "running" && member.activity === "mid-turn") tally.working++;
          else if (member.lifecycle === "running" && member.activity === "idle") tally.idle++;
          else if (["done", "killed", "error", "crashed"].includes(member.lifecycle)) {
            const updated = Date.parse(member.updatedAt ?? "");
            if (!Number.isFinite(updated) || updated > sampleTime) { partial = true; continue; }
            if (sampleTime - updated < 30000) {
              if (member.lifecycle === "done" || member.lifecycle === "killed") tally.ended++;
              else tally.error++;
            }
          } else partial = true;
        }
        successes++;
      } catch { partial = true; }
    }
  }
  if (channels.size > 0 && successes === 0) return unavailable(members, "error");
  if (partial && channels.size === 0) return unavailable(members, "error");
  return Object.fromEntries(members.map(id => [id, {
    state: partial ? "partial" : "ready", value: tally[id], source: "teamwork", observedAt: sampleTime,
    ...(channels.size === 0 ? { basis: "暂无协作" } : {}),
  }]));
}

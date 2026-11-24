import type { PluginServerContext } from "@getpaseo/plugin/server";
import { emptySnapshot, insightsRpc } from "./shared/metrics.ts";
import { createLifecycleCchpReader, createLifecycleLocalReader } from "./server/lifecycle-cchp.ts";
import { readCodex } from "./server/codex.ts";
import { fixtureSnapshot } from "./server/fixture.ts";
import { createSnapshotHandler } from "./server/snapshot.ts";
import { readProgress, readTeamwork, runTrellis } from "./server/workflow.ts";

export default function contribute(server: PluginServerContext) {
  const fixture = process.env.PASEO_SESSION_INSIGHTS_FIXTURE === "1";
  const workflow = process.env.PASEO_SESSION_INSIGHTS_WORKFLOW;
  const readCchp = createLifecycleCchpReader();
  const readLocal = createLifecycleLocalReader();
  const lifetime = new AbortController();
  const progress = new Map<string, { expires: number; read: ReturnType<typeof readProgress> }>();
  const run: Parameters<typeof readProgress>[1] = (args, cwd, timeout) => runTrellis(args, cwd, timeout, lifetime.signal);
  function projectProgress(root: string) {
    const existing = progress.get(root);
    const now = Date.now();
    if (existing && existing.expires > now) return existing.read;
    for (const [path, value] of progress) if (value.expires <= now) progress.delete(path);
    if (progress.size >= 128) return Promise.resolve({});
    const read = readProgress(root, run);
    progress.set(root, { expires: now + 60_000, read });
    return read;
  }
  const handler = createSnapshotHandler(async subject => {
    if (fixture) return fixtureSnapshot(Date.now());
    const snapshot = emptySnapshot("unsupported");
    if (!subject.threadId) {
      for (const id of ["input", "output", "cachedInput", "cache", "compactions", "cost", "ttft", "tps", "working", "idle", "error", "ended"] as const) {
        snapshot.metrics[id] = { state: "waiting" };
      }
    }
    const gateway = readCchp(subject.threadId, lifetime.signal);
    const local = await readLocal(lifetime.signal);
    const codexHome = process.env.PASEO_SESSION_INSIGHTS_CODEX_HOME ?? local?.codexHome;
    const readWorkflow = workflow === undefined ? Boolean(local) : workflow === "1";
    const results = await Promise.all([
      codexHome && readCodex(codexHome, subject.threadId, lifetime.signal),
      gateway,
      readWorkflow && subject.workspaceRoot && projectProgress(subject.workspaceRoot),
      readWorkflow && subject.workspaceRoot && readTeamwork(subject.workspaceRoot, subject.threadId, run),
    ]);
    for (const projection of results) if (projection) Object.assign(snapshot.metrics, projection);
    return snapshot;
  });
  server.handle(insightsRpc, (target, { paseo }) => handler.read(target, async ({ workspaceId, agentId }) => {
    const handle = paseo.agents.ref(agentId);
    const value = await handle.refresh();
    if (!value || value.agent.id !== agentId || value.agent.workspaceId !== workspaceId ||
      value.agent.provider !== "codex" || value.agent.archivedAt || value.agent.status === "closed") return null;
    const { serverId } = handle.address;
    if (!serverId) return null;
    return {
      serverId, workspaceId, agentId,
      threadId: value.agent.runtimeInfo?.sessionId ?? null,
      workspaceRoot: value.project?.checkout.worktreeRoot ?? value.project?.checkout.mainRepoRoot ??
        value.project?.checkout.cwd ?? null,
    };
  }));
  return () => {
    lifetime.abort();
    handler.stop();
    progress.clear();
  };
}

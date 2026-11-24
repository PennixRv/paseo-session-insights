import { emptySnapshot, snapshotSchema, type Snapshot, type Target } from "../shared/metrics.ts";

export type Subject = Target & {
  serverId: string;
  threadId: string | null;
  workspaceRoot: string | null;
};
type ReadSources = (subject: Subject) => Promise<Snapshot>;
type ResolveSubject = (target: Target) => Promise<Subject | null>;

function key(subject: Subject): string {
  return JSON.stringify([subject.serverId, subject.workspaceId, subject.agentId, subject.threadId, subject.workspaceRoot]);
}

export function createSnapshotHandler(readSources: ReadSources) {
  const active = new Map<string, Promise<Snapshot>>();
  let stopped = false;
  return {
    stop() {
      stopped = true;
      active.clear();
    },
    async read(target: Target, resolve: ResolveSubject): Promise<Snapshot> {
      if (stopped) return emptySnapshot("error");
      try {
        const initial = await resolve(target);
        if (!initial) return emptySnapshot("unlinked");
        if (stopped) return emptySnapshot("error");
        const id = key(initial);
        let promise = active.get(id);
        if (!promise) {
          if (active.size >= 8) return emptySnapshot("rate-limited");
          promise = readSources(initial).then(value => snapshotSchema.parse(value))
            .finally(() => active.delete(id));
          active.set(id, promise);
        }
        const result = await promise;
        const final = await resolve(target);
        return !stopped && final && id === key(final) ? result : emptySnapshot("unlinked");
      } catch {
        return emptySnapshot("error");
      }
    },
  };
}

import { useAgent, useComposers, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { findFocusedAgent } from "./client/focus.ts";
import { createSession, type InsightSession } from "./client/session.ts";
import { SidebarMetrics } from "./client/sidebar.tsx";
import { insightsRpc, type Target } from "./shared/metrics.ts";

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const entries = new Map<string, Target & {
    session: InsightSession; runtimeId: string | null; running: boolean;
  }>();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const notify = () => { for (const listener of listeners) listener(); };

  function Footer(props: PluginSidebarItemProps) {
    const [focused] = useComposers({ focused: true });
    const entry = useSyncExternalStore(subscribe, () => {
      if (!focused) return null;
      const id = findFocusedAgent(client.composers, entries.keys());
      return id === null ? null : entries.get(id) ?? null;
    });
    const agent = useAgent(entry?.agentId ?? "");
    if (!entry || !agent || agent.hostId !== props.host.id || agent.workspaceId !== entry.workspaceId) return null;
    return <SidebarMetrics key={agent.ref.key} {...props} title={agent.title} session={entry.session} />;
  }

  const unregisterFooter = client.addSidebarFooterItem({
    id: "session-insights",
    title: "会话指标",
    Component: Footer,
  });
  const remove = (id: string) => {
    entries.get(id)?.session.dispose();
    entries.delete(id);
  };
  const upsert = (agent: {
    id: string; provider: string; status: string; workspaceId?: string | null;
    archivedAt?: string | null; runtimeInfo?: { sessionId?: string | null } | null;
  }) => {
    if (lifetime.signal.aborted) return;
    if (agent.provider !== "codex" || !agent.workspaceId || agent.archivedAt || agent.status === "closed") {
      remove(agent.id);
      return;
    }
    const runtimeId = agent.runtimeInfo?.sessionId ?? null;
    const running = agent.status === "running";
    const existing = entries.get(agent.id);
    if (existing?.workspaceId === agent.workspaceId) {
      if (existing.runtimeId !== runtimeId) existing.session.invalidate();
      else if (existing.running && !running) existing.session.refreshIfMounted();
      Object.assign(existing, { runtimeId, running });
      return;
    }
    remove(agent.id);
    const target = { workspaceId: agent.workspaceId, agentId: agent.id };
    entries.set(agent.id, {
      ...target,
      session: createSession(() => client.rpc(insightsRpc, target)),
      runtimeId,
      running,
    });
  };

  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) return;
    subscription.subscribe({
      snapshot: ({ entries: snapshot }) => {
        if (lifetime.signal.aborted) return;
        const ids = new Set(snapshot.map(({ agent }) => agent.id));
        for (const id of entries.keys()) if (!ids.has(id)) remove(id);
        for (const { agent } of snapshot) upsert(agent);
        notify();
      },
      update: message => {
        if (lifetime.signal.aborted || message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") upsert(update.agent);
        else remove(update.agentId);
        notify();
      },
    });
  }).catch(() => {
    if (!lifetime.signal.aborted) console.warn("Session insights could not observe the Paseo agent directory.");
  });
  return () => {
    lifetime.abort();
    unregisterFooter();
    for (const id of entries.keys()) remove(id);
    notify();
    listeners.clear();
  };
}

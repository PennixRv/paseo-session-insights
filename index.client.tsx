import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Details, useRefreshWhileVisible } from "./client/details.tsx";
import { fieldIcons } from "./client/icons.ts";
import { createSession } from "./client/session.ts";
import { formatSummary } from "./shared/format.ts";
import { insightsRpc, summaryGroups, type Target } from "./shared/metrics.ts";

function register(client: PluginClientContext, target: Target, desktop: boolean) {
  const session = createSession(() => client.rpc(insightsRpc, target));
  const pills: PluginButtonRegistration[] = [];

  function DesktopDetailsIcon(props: PluginButtonIconProps) {
    const [instance] = useState(() => Symbol());
    const { open, owner } = useSyncExternalStore(session.subscribe, session.current);
    useEffect(() => session.attach(instance), [instance]);
    useRefreshWhileVisible(session, owner === instance);
    return (
      <>
        <Icon icon={fieldIcons.input} size={props.size} color={props.color} />
        {open && owner === instance && (
          <Modal title="会话指标" open onOpenChange={session.setOpen}>
            <Modal.Content>
              <Details session={session} theme={props.theme} layout={props.layout} />
            </Modal.Content>
          </Modal>
        )}
      </>
    );
  }

  if (desktop) {
    const groups = formatSummary(session.current().snapshot);
    for (const [index, group] of summaryGroups.entries()) {
      const { label, title } = groups[index];
      pills.push(client.addComposerPill({
        ...target, id: `insights-${group.id}`,
        button: {
          title, label,
          icon: index === 0 ? DesktopDetailsIcon : fieldIcons[group.ids[0]],
          behavior: { kind: "action", onPress: () => session.setOpen(true) },
        },
      }));
    }
  } else {
    pills.push(client.addComposerPill({
      ...target, id: "session-insights",
      button: {
        title: "会话指标", icon: "ChartNoAxesColumnIncreasing",
        behavior: { kind: "popover", Content: props => (
          <Details theme={props.theme} layout={props.layout} session={session} />
        ) },
      },
    }));
  }

  let previous = session.current().snapshot;
  const unsubscribe = session.subscribe(() => {
    if (!desktop || session.current().snapshot === previous) return;
    previous = session.current().snapshot;
    formatSummary(previous).forEach(({ label, title }, index) => pills[index].update({ label, title }));
  });
  return {
    refresh: session.refreshIfMounted,
    invalidate: session.invalidate,
    remove() {
      unsubscribe();
      session.dispose();
      for (const pill of pills) pill.remove();
    },
  };
}

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const desktop = Platform.OS !== "ios" && Platform.OS !== "android";
  const entries = new Map<string, ReturnType<typeof register> & {
    workspaceId: string; runtimeId: string | null; running: boolean;
  }>();
  const remove = (id: string) => {
    entries.get(id)?.remove();
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
      if (existing.runtimeId !== runtimeId) existing.invalidate();
      else if (existing.running && !running && desktop) void existing.refresh();
      Object.assign(existing, { runtimeId, running });
      return;
    }
    remove(agent.id);
    entries.set(agent.id, {
      ...register(client, { workspaceId: agent.workspaceId, agentId: agent.id }, desktop),
      workspaceId: agent.workspaceId, runtimeId, running,
    });
  };

  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) return;
    subscription.subscribe({
      snapshot: ({ entries: snapshot }) => {
        for (const id of entries.keys()) remove(id);
        for (const { agent } of snapshot) upsert(agent);
      },
      update: message => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") upsert(update.agent);
        else remove(update.agentId);
      },
    });
  }).catch(() => {
    if (!lifetime.signal.aborted) console.warn("Session insights could not observe the Paseo agent directory.");
  });
  return () => {
    lifetime.abort();
    for (const id of entries.keys()) remove(id);
  };
}

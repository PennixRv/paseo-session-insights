import { useAgent, useComposers, useWorkspace, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { AccountMetrics, accountTitle, useAccount } from "./client/account.tsx";
import { accountCache } from "./client/account-state.ts";
import { findFocusedAgent } from "./client/focus.ts";
import { createSession, type InsightSession } from "./client/session.ts";
import { SidebarMetrics } from "./client/sidebar.tsx";
import { insightsRpc, type Target } from "./shared/metrics.ts";
import { accountRpc } from "./shared/account.ts";

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const entries = new Map<string, Target & {
    session: InsightSession; runtimeId: string | null;
  }>();
  const accountView = accountCache.attach(statusOnly => client.rpc(accountRpc, statusOnly ? { statusOnly: true } : {}));
  void accountView.probe();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const notify = () => { for (const listener of listeners) listener(); };

  function Footer(props: PluginSidebarItemProps) {
    const showAccount = useSyncExternalStore(accountView.subscribe, () => accountView.showAccount);
    const compact = props.layout.compact || props.layout.platform !== "web";
    const account = useAccount(accountView, !compact || showAccount);
    const enabled = account !== undefined && account.state !== "disabled";
    const [focused] = useComposers({ focused: true });
    const entry = useSyncExternalStore(subscribe, () => {
      if (!focused) return null;
      const id = findFocusedAgent(client.composers, entries.keys());
      return id === null ? null : entries.get(id) ?? null;
    });
    const agent = useAgent(entry?.agentId ?? "");
    const workspaceName = useWorkspace(agent?.workspace ?? "", workspace => workspace.title?.trim() || workspace.name);
    const hasSession = !!entry && !!agent && agent.hostId === props.host.id && agent.workspaceId === entry.workspaceId;
    const accountVisible = compact ? enabled && showAccount : account?.state !== "disabled";
    if (!hasSession && !enabled && !accountVisible) return null;
    const sessionVisible = !compact || !accountVisible;
    const switcher = compact && enabled && <Pressable testID="insights-account-toggle"
      accessibilityRole="button" accessibilityLabel={accountVisible ? "切换到会话指标" : "切换到账号指标"}
      onPress={() => {
        accountView.showAccount = !accountVisible;
      }}
      style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
      <Icon name="ArrowLeftRight" size={18} color={props.theme.colors.accent} />
    </Pressable>;
    return <>
      {accountVisible && <View style={{ paddingHorizontal: 8, paddingVertical: 5, gap: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text accessibilityRole="header" style={{ color: props.theme.colors.foreground, fontSize: 15, fontWeight: "400" }}>{accountTitle}</Text>
          {switcher}
        </View>
        <AccountMetrics {...props} reading={account} />
      </View>}
      {sessionVisible && hasSession && <>
        {accountVisible && <View style={{ height: 1, backgroundColor: props.theme.colors.border }} />}
        <SidebarMetrics key={agent.ref.key} {...props} title={workspaceName}
          session={entry.session} codexSessionId={entry.runtimeId} trailing={switcher} />
      </>}
      {sessionVisible && !hasSession && compact && enabled && <View
        style={{ paddingLeft: 8, paddingRight: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 14 }}>没有当前会话</Text>
        {switcher}
      </View>}
    </>;
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
      if (existing.runtimeId !== runtimeId) {
        entries.set(agent.id, { ...existing, runtimeId });
        existing.session.invalidate();
      }
      existing.session.setRunning(running);
      return;
    }
    remove(agent.id);
    const target = { workspaceId: agent.workspaceId, agentId: agent.id };
    const session = createSession(() => client.rpc(insightsRpc, target));
    session.setRunning(running);
    entries.set(agent.id, { ...target, session, runtimeId });
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
    accountView.dispose();
    unregisterFooter();
    for (const id of entries.keys()) remove(id);
    notify();
    listeners.clear();
  };
}

import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { formatMetric, stateLabels } from "../shared/format.ts";
import { detailGroups, labels, type MetricId } from "../shared/metrics.ts";
import { Details } from "./details.tsx";
import type { InsightSession } from "./session.ts";

const shortLabels = {
  input: "输入", output: "输出", cachedInput: "缓存输入", cache: "缓存率", compactions: "压缩", cost: "已结算",
  ttft: "首 token", tps: "输出速率", planning: "规划", inProgress: "进行", completed: "完成", cancelled: "取消",
  working: "执行", idle: "空闲", error: "出错", ended: labels.ended,
} satisfies Record<MetricId, string>;

export function SidebarMetrics({
  theme, layout, session, title, codexSessionId, trailing,
}: Pick<PluginSidebarItemProps, "theme" | "layout"> & {
  session: InsightSession; title: string | null; codexSessionId: string | null; trailing?: ReactNode;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.current);
  const [open, setOpen] = useState(false);
  const { accent, foreground, foregroundMuted } = theme.colors;
  const metricSize = 14;
  const metricInk = { color: foreground, opacity: 0.82 };
  const columnGap = layout.compact ? 28 : 20;
  useEffect(() => {
    session.setForeground(AppState.currentState === "active" || AppState.currentState === null);
    const detach = session.attach();
    const subscription = AppState.addEventListener("change", state => session.setForeground(state === "active"));
    return () => {
      subscription.remove();
      detach();
    };
  }, [session]);
  const status = [
    snapshot.fixture ? "演示数据" : "",
    ...detailGroups.flatMap(group => group.ids).flatMap(id => {
      const reading = snapshot.metrics[id];
      if (id === "cost") return [];
      if (reading.state === "partial") return [`${shortLabels[id]}：${reading.basis ?? "覆盖不完整"}`];
      if (reading.state === "stale") return [`${shortLabels[id]}：已过期`];
      return [];
    }),
  ].filter(Boolean).join(" · ");

  const renderMetric = (id: MetricId) => {
    const reading = snapshot.metrics[id];
    const value = formatMetric(id, reading, true);
    return (
      <View key={id} testID={`insights-sidebar-metric-${id}`} accessible
        accessibilityLabel={[labels[id], value, stateLabels[reading.state], reading.basis].filter(Boolean).join("，")}
        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 5 }}>
        <Text style={{ ...metricInk, fontSize: metricSize, flexShrink: 1 }}>{shortLabels[id]}</Text>
        <Text style={{ ...metricInk, fontSize: metricSize, fontVariant: ["tabular-nums"] }}>{value}</Text>
      </View>
    );
  };
  const sessionRows = [...detailGroups[0].ids, ...detailGroups[1].ids];

  return (
    <View testID="insights-sidebar" style={{ paddingHorizontal: 8, paddingVertical: 5, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text testID="insights-sidebar-title" accessibilityRole="header" numberOfLines={1}
          style={{ flex: 1, minWidth: 0, color: foreground, fontSize: 15, fontWeight: "400" }}>{title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Pressable testID="insights-sidebar-details" accessibilityRole="button" accessibilityLabel="会话详情" onPress={() => setOpen(true)}
            style={{ width: layout.compact || layout.platform !== "web" ? 48 : 36,
              height: layout.compact || layout.platform !== "web" ? 48 : 32,
              alignItems: "center", justifyContent: "center" }}>
            <Icon name="List" size={18} color={accent} />
          </Pressable>
          {trailing}
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {sessionRows.map((id, index) => (
          <View key={id} style={{
            width: "50%", paddingBottom: 3,
            ...(index % 2 === 0 ? { paddingRight: columnGap / 2 } : { paddingLeft: columnGap / 2 }),
          }}>{renderMetric(id)}</View>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: columnGap }}>
        {detailGroups.slice(2).map((group, index) => (
          <View key={group.title} style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text accessibilityRole="header" style={{ color: foreground, fontSize: metricSize, fontWeight: "400" }}>
              {index === 0 ? "Trellis" : "Teamwork"}
            </Text>
            {group.ids.map(renderMetric)}
          </View>
        ))}
      </View>
      {!!status && <Text style={{ color: foregroundMuted, fontSize: 11 }}>{status}</Text>}
      {open && <Modal title="会话指标" open onOpenChange={next => {
        if (!next) session.stopBilling();
        setOpen(next);
      }}>
        <Modal.Content contentContainerStyle={layout.compact ? { paddingHorizontal: 16 } : undefined}>
          <Details session={session} theme={theme} layout={layout} codexSessionId={codexSessionId} />
        </Modal.Content>
      </Modal>}
    </View>
  );
}

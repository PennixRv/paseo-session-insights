import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { formatMetric, stateLabels } from "../shared/format.ts";
import { detailGroups, labels, type MetricId } from "../shared/metrics.ts";
import { Details } from "./details.tsx";
import type { InsightSession } from "./session.ts";

const shortLabels = {
  input: "输入", output: "输出", cachedInput: "缓存输入", cache: "缓存率", compactions: "压缩", cost: "已结算",
  ttft: "首 token", tps: "输出速率", planning: "规划", inProgress: "进行", completed: "完成", cancelled: "取消",
  working: "执行", idle: "空闲", error: "出错", ended: "最近结束",
} satisfies Record<MetricId, string>;

export function SidebarMetrics({
  theme, layout, session, title, codexSessionId,
}: Pick<PluginSidebarItemProps, "theme" | "layout"> & {
  session: InsightSession; title: string | null; codexSessionId: string | null;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.current);
  const [open, setOpen] = useState(false);
  const { foreground, foregroundMuted } = theme.colors;
  const metricSize = 13;
  const metricInk = { color: foreground, opacity: 0.82 };
  const columnGap = layout.compact ? 24 : 16;
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
        <Text accessibilityRole="header" style={{ color: foreground, fontWeight: "600", fontSize: 14 }}>会话指标</Text>
        <Text testID="insights-sidebar-title" numberOfLines={1} style={{ flex: 1, minWidth: 0, ...metricInk, fontSize: 14 }}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="查看会话指标详情" onPress={() => {
          setOpen(true);
          void session.refresh();
        }}
          style={{ minHeight: layout.compact ? 44 : 24, paddingHorizontal: 4, justifyContent: "center" }}>
          <Text style={{ color: foregroundMuted, fontSize: 14 }}>详情</Text>
        </Pressable>
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
            <Text accessibilityRole="header" style={{ color: foreground, fontSize: metricSize, fontWeight: "600" }}>
              {index === 0 ? "Trellis" : "Teamwork"}
            </Text>
            {group.ids.map(renderMetric)}
          </View>
        ))}
      </View>
      {!!status && <Text style={{ color: foregroundMuted, fontSize: 11 }}>{status}</Text>}
      {open && <Modal title="会话指标" open onOpenChange={setOpen}>
        <Modal.Content><Details session={session} theme={theme} layout={layout} codexSessionId={codexSessionId} /></Modal.Content>
      </Modal>}
    </View>
  );
}

import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { formatSidebarMetric, stateLabels } from "../shared/format.ts";
import { detailGroups, labels, type MetricId } from "../shared/metrics.ts";
import { Details, useRefreshWhileVisible } from "./details.tsx";
import type { InsightSession } from "./session.ts";

const shortLabels = {
  input: "输入", output: "输出", cache: "缓存", compactions: "压缩", cost: "费用",
  ttft: "首 token", tps: "输出速率", planning: "规划", inProgress: "进行", completed: "完成",
  working: "执行", idle: "空闲", error: "出错", ended: "最近结束",
} satisfies Record<MetricId, string>;

export function SidebarMetrics({
  theme, layout, session, title,
}: Pick<PluginSidebarItemProps, "theme" | "layout"> & { session: InsightSession; title: string | null }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.current);
  const [open, setOpen] = useState(false);
  const { foreground, foregroundMuted, border } = theme.colors;
  useRefreshWhileVisible(session);
  const partial = Object.values(snapshot.metrics).some(metric => metric.state === "partial");
  const stale = Object.values(snapshot.metrics).some(metric => metric.state === "stale");
  const status = [snapshot.fixture && "演示数据", partial && "* 部分覆盖", stale && "~ 已过期"].filter(Boolean).join(" · ");

  const renderMetric = (id: MetricId) => {
    const reading = snapshot.metrics[id];
    const value = formatSidebarMetric(id, reading);
    return (
      <View key={id} testID={`insights-sidebar-metric-${id}`} accessible
        accessibilityLabel={[labels[id], value, stateLabels[reading.state]].filter(Boolean).join("，")}
        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 5 }}>
        <Text style={{ color: foregroundMuted, fontSize: 11, flexShrink: 1 }}>{shortLabels[id]}</Text>
        <Text style={{ color: foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{value}</Text>
      </View>
    );
  };
  const sessionRows = [...detailGroups[0].ids, ...detailGroups[1].ids];

  return (
    <View testID="insights-sidebar" style={{ paddingHorizontal: 8, paddingVertical: 5, gap: 5, borderTopColor: border, borderTopWidth: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: foregroundMuted, fontWeight: "600", fontSize: 13 }}>会话指标</Text>
        <Text testID="insights-sidebar-title" numberOfLines={1} style={{ flex: 1, color: foregroundMuted, fontSize: 11 }}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="查看会话指标详情" onPress={() => setOpen(true)}
          style={{ minHeight: 24, paddingHorizontal: 4, justifyContent: "center" }}>
          <Text style={{ color: foregroundMuted, fontSize: 11 }}>详情</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {sessionRows.map(id => <View key={id} style={{ width: "50%", paddingRight: 6, paddingBottom: 3 }}>{renderMetric(id)}</View>)}
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {detailGroups.slice(2).map((group, index) => (
          <View key={group.title} style={{ flex: 1, gap: 3 }}>
            <Text accessibilityRole="header" style={{ color: foregroundMuted, fontSize: 11, fontWeight: "600" }}>
              {index === 0 ? "Trellis" : "Teamwork"}
            </Text>
            {group.ids.map(renderMetric)}
          </View>
        ))}
      </View>
      {!!status && <Text style={{ color: foregroundMuted, fontSize: 10 }}>{status}</Text>}
      {open && <Modal title="会话指标" open onOpenChange={setOpen}>
        <Modal.Content><Details session={session} theme={theme} layout={layout} /></Modal.Content>
      </Modal>}
    </View>
  );
}

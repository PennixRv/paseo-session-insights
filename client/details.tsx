import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { formatMetric, stateLabels } from "../shared/format.ts";
import { detailGroups, labels, type Metric, type MetricSource } from "../shared/metrics.ts";
import type { InsightSession } from "./session.ts";

const sourceLabels: Record<MetricSource, string> = {
  codex: "Codex 本地", cchp: "CCHP", sub2api: "sub2api", trellis: "Trellis", teamwork: "Teamwork", fixture: "演示数据",
};

function timeText(stamp: number): string {
  return new Date(stamp).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}

function metadata(reading: Metric): string {
  return [
    stateLabels[reading.state], reading.source && sourceLabels[reading.source],
    reading.sampleAt !== undefined ? `样本 ${timeText(reading.sampleAt)}` :
      reading.observedAt !== undefined ? `读取 ${timeText(reading.observedAt)}` : "",
    reading.basis,
  ].filter(Boolean).join(" · ");
}

export function Details({
  theme, layout, session, codexSessionId,
}: Pick<PluginSidebarItemProps, "theme" | "layout"> & { session: InsightSession; codexSessionId: string | null }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.current);
  const { running, continuing, reading } = useSyncExternalStore(session.subscribe, session.status);
  const { fontScale, width } = useWindowDimensions();
  const toast = useToast();
  const columns = fontScale >= 1.25 || width < 360 ? 1 : 2;
  const { colors } = theme;
  const metricText = { color: colors.foreground, opacity: 0.9, fontSize: 15 };
  const secondaryInk = { color: colors.foreground, opacity: 0.82 };
  const note = { ...secondaryInk, fontSize: 12 };
  const sessionIdText = { ...secondaryInk, fontSize: 14 };

  return (
    <View style={{ gap: 14 }}>
      <View style={{ minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text testID="insights-codex-session-id" selectable
          accessibilityLabel={codexSessionId ? `Codex 会话 ID ${codexSessionId}` : undefined}
          style={{ ...sessionIdText, flexShrink: 1 }}>
          {codexSessionId ?? "等待 Codex 会话 ID"}
        </Text>
        {codexSessionId && <Pressable accessibilityRole="button" accessibilityLabel="复制 Codex 会话 ID"
          onPress={() => { void copyText(codexSessionId).then(
            () => toast.show("已复制会话 ID"), () => toast.error("无法复制会话 ID"),
          ); }} hitSlop={6}
          style={{ flexShrink: 0, minHeight: 44, justifyContent: "center" }}>
          <Text style={sessionIdText}>复制</Text>
        </Pressable>}
      </View>
      {snapshot.fixture && <Text style={metricText}>演示数据</Text>}
      {detailGroups.map(group => (
        <View key={group.title} style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text accessibilityRole="header" style={{
              color: colors.foreground, fontSize: 15, fontWeight: group.ids === detailGroups[2].ids || group.ids === detailGroups[3].ids ? "400" : "500",
            }}>{group.title}</Text>
            {group === detailGroups[0] && (
              <Pressable testID="insights-details-refresh" accessibilityRole="button"
                accessibilityState={{ busy: reading, disabled: reading }} disabled={reading}
                onPress={() => { void session.refresh(); }}
                accessibilityLabel="刷新会话指标"
                style={{ flexShrink: 0, minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center",
                  opacity: reading ? 0.55 : 1 }}>
                <Icon name="RefreshCw" size={18} color={colors.accent} />
              </Pressable>
            )}
          </View>
          {Array.from({ length: Math.ceil(group.ids.length / columns) }, (_, row) => (
            <View key={row} style={{ flexDirection: "row", gap: 6, alignItems: "stretch" }}>
              {group.ids.slice(row * columns, (row + 1) * columns).map(id => {
                const reading = snapshot.metrics[id];
                const context = metadata(reading);
                return (
                  <View key={id} testID={`insights-detail-metric-${id}`}
                    style={{ flex: 1, minWidth: 0, backgroundColor: colors.surface1, borderRadius: 8, padding: layout.compact ? 8 : 10, gap: 3 }}>
                    <Text style={metricText}>{labels[id]}</Text>
                    <Text style={{ ...metricText, fontVariant: ["tabular-nums"] }}>{formatMetric(id, reading)}</Text>
                    {!!context && <Text style={note}>{context}</Text>}
                  </View>
                );
              })}
            </View>
          ))}
          {group.ids === detailGroups[0].ids && snapshot.metrics.cost.hasMoreBilling && (continuing || !running) && (
            <Pressable accessibilityRole="button" testID="insights-billing-continue"
              onPress={continuing ? session.stopBilling : session.continueBilling}
              style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}>
              <Text style={{ ...metricText, fontWeight: "500" }}>{continuing ? "暂停核对" : "继续核对"}</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

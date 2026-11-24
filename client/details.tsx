import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { formatMetric, stateLabels } from "../shared/format.ts";
import { detailGroups, labels, type Metric, type MetricSource } from "../shared/metrics.ts";
import { fieldGlyphs } from "./glyphs.ts";
import type { InsightSession } from "./session.ts";

const sourceLabels: Record<MetricSource, string> = {
  codex: "Codex 本地", cchp: "CCHP", sub2api: "sub2api", trellis: "Trellis", teamwork: "Teamwork", fixture: "演示数据",
};

function timeText(stamp: number): string {
  return new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function metadata(reading: Metric): string {
  return [
    stateLabels[reading.state], reading.source && sourceLabels[reading.source],
    reading.sampleAt !== undefined ? `样本 ${timeText(reading.sampleAt)}` :
      reading.observedAt !== undefined ? `读取 ${timeText(reading.observedAt)}` : "",
    reading.basis,
  ].filter(Boolean).join(" · ");
}

export function useRefreshWhileVisible(session: InsightSession) {
  useEffect(() => {
    const detach = session.attach();
    const refresh = () => {
      if (AppState.currentState === "active" || AppState.currentState === null) void session.refresh();
    };
    refresh();
    const subscription = AppState.addEventListener("change", refresh);
    const timer = setInterval(refresh, 15_000);
    return () => {
      clearInterval(timer);
      subscription.remove();
      detach();
    };
  }, [session]);
}

export function Details({
  theme, layout, session, codexSessionId,
}: Pick<PluginSidebarItemProps, "theme" | "layout"> & { session: InsightSession; codexSessionId: string | null }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.current);
  const { fontScale, width } = useWindowDimensions();
  const [refreshing, setRefreshing] = useState(false);
  const showGlyphs = !layout.compact && Platform.OS !== "ios" && Platform.OS !== "android";
  const singleColumn = fontScale >= 1.25 || width < 360;
  const { colors } = theme;

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text testID="insights-codex-session-id" selectable
          accessibilityLabel={codexSessionId ? `Codex 会话 ID ${codexSessionId}` : undefined}
          style={{ flex: 1, minWidth: 0, color: colors.foregroundMuted, fontSize: 12 }}>
          {codexSessionId ?? "等待 Codex 会话 ID"}
        </Text>
        <Pressable
          testID="insights-details-refresh"
          accessibilityRole="button"
          accessibilityState={{ busy: refreshing, disabled: refreshing }}
          disabled={refreshing}
          onPress={() => {
            setRefreshing(true);
            void session.refresh().finally(() => setRefreshing(false));
          }}
          style={{ flexShrink: 0, paddingHorizontal: 8, minHeight: 32, justifyContent: "center" }}
        >
          <Text style={{ color: colors.foreground }}>{refreshing ? "正在刷新" : "刷新"}</Text>
        </Pressable>
      </View>
      {snapshot.fixture && <Text style={{ color: colors.foregroundMuted }}>演示数据</Text>}
      {detailGroups.map(group => (
        <View key={group.title} style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "600" }}>{group.title}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {group.ids.map(id => {
              const reading = snapshot.metrics[id];
              const context = metadata(reading);
              return (
                <View key={id} style={{ width: singleColumn ? "100%" : "50%", padding: 3 }}>
                  <View style={{ backgroundColor: colors.surface1, borderRadius: 8, padding: layout.compact ? 8 : 10, gap: 3 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                      {showGlyphs && (
                        <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                          <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>{fieldGlyphs[id]}</Text>
                        </View>
                      )}
                      <Text style={{ color: colors.foregroundMuted, flexShrink: 1 }}>{labels[id]}</Text>
                    </View>
                    <Text style={{ color: colors.foreground, fontVariant: ["tabular-nums"] }}>{formatMetric(id, reading)}</Text>
                    {!!context && <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{context}</Text>}
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { formatMetric, stateLabels } from "../shared/format.ts";
import { detailGroups, labels, type Metric, type MetricSource } from "../shared/metrics.ts";
import type { InsightSession } from "./session.ts";

const sourceLabels: Record<MetricSource, string> = {
  codex: "Codex 本地", cchp: "CCHP", sub2api: "sub2api", trellis: "Trellis", teamwork: "Teamwork", fixture: "演示数据",
};

const refreshLabels = {
  paused: "空闲已暂停", automatic: "自动刷新", settling: "等待轮次结束后的补读", continuing: "正在续查账单",
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
  const { mode, reading, lastReadAt } = useSyncExternalStore(session.subscribe, session.status);
  const { fontScale, width } = useWindowDimensions();
  const [waitUntil, setWaitUntil] = useState(0);
  const toast = useToast();
  useEffect(() => {
    if (!waitUntil) return;
    const timer = setTimeout(() => setWaitUntil(0), Math.max(0, waitUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [waitUntil]);
  const columns = fontScale >= 1.25 || width < 360 ? 1 : 2;
  const { colors } = theme;
  const metricText = { color: colors.foreground, opacity: 0.9, fontSize: 15 };
  const secondaryInk = { color: colors.foreground, opacity: 0.82 };
  const note = { ...secondaryInk, fontSize: 12 };
  const emphasizedNote = { ...secondaryInk, fontSize: 13, fontWeight: "500" as const };
  const { cost, ttft, tps } = snapshot.metrics;
  const requestId = ttft.requestId === tps.requestId && ttft.sampleAt === tps.sampleAt &&
    ttft.source === tps.source ? ttft.requestId : undefined;
  const coverage = cost.billing;
  const retryText = cost.retryAt !== undefined && cost.retryAt > Date.now()
    ? `CCHP 限流，${timeText(cost.retryAt)} 后可重试` : undefined;
  const copy = (value: string, label: string) => {
    void copyText(value).then(() => toast.show(`已复制${label}`), () => toast.error(`无法复制${label}`));
  };

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text testID="insights-codex-session-id" selectable
          accessibilityLabel={codexSessionId ? `Codex 会话 ID ${codexSessionId}` : undefined}
          style={{ flex: 1, minWidth: 0, ...secondaryInk, fontSize: 13 }}>
          {codexSessionId ?? "等待 Codex 会话 ID"}
        </Text>
        <Pressable
          testID="insights-details-refresh"
          accessibilityRole="button"
          accessibilityState={{ busy: reading, disabled: reading }}
          disabled={reading}
          onPress={() => {
            const wait = session.refreshFromDetails();
            setWaitUntil(wait ? Date.now() + wait : 0);
          }}
          style={{ flexShrink: 0, paddingHorizontal: 8, minHeight: 32, justifyContent: "center" }}
        >
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "500" }}>{reading ? "正在读取" : "刷新"}</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text accessibilityLiveRegion="polite" testID="insights-refresh-status" style={{ ...note, flex: 1 }}>
          {[
            reading ? "正在读取" : refreshLabels[mode],
            lastReadAt !== undefined ? `上次读取 ${timeText(lastReadAt)}` : undefined,
            !reading && waitUntil > Date.now() ? `${timeText(waitUntil)} 后可再次刷新` : undefined,
          ].filter(Boolean).join(" · ")}
        </Text>
        {codexSessionId && <Pressable accessibilityRole="button" accessibilityLabel="复制 Codex 会话 ID"
          onPress={() => copy(codexSessionId, "会话 ID")} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}>
          <Text style={emphasizedNote}>复制会话 ID</Text>
        </Pressable>}
      </View>
      {snapshot.fixture && <Text style={metricText}>演示数据</Text>}
      {detailGroups.map(group => (
        <View key={group.title} style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 15, fontWeight: "500" }}>{group.title}</Text>
          {group.ids === detailGroups[2].ids && <Text style={note}>统计范围为当前工作区所属项目</Text>}
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
          {group.ids === detailGroups[0].ids && (coverage || retryText) && (
            <View style={{ gap: 4 }}>
              <Text accessibilityLiveRegion="polite" testID="insights-billing-progress"
                style={retryText || (coverage?.pending ?? 0) > 0 ? emphasizedNote : note}>
                {[
                  coverage && `已核对 ${coverage.checked} 条`,
                  coverage && `待结算 ${coverage.pending} 条`,
                  coverage && (coverage.pages === "complete" ? "已到末页" :
                    coverage.pages === "unconfirmed" ? "已到末页，网关未确认完整覆盖" : "还有余页"),
                  retryText,
                ].filter(Boolean).join(" · ")}
              </Text>
              {coverage?.pages === "more" && mode !== "automatic" && (
                <Pressable accessibilityRole="button" testID="insights-billing-continue"
                  onPress={mode === "continuing" ? session.stopBilling : session.continueBilling}
                  style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}>
                  <Text style={{ ...metricText, fontWeight: "500" }}>{mode === "continuing" ? "暂停核对" : "继续核对"}</Text>
                </Pressable>
              )}
            </View>
          )}
          {group.ids === detailGroups[1].ids && requestId && (
            <Pressable accessibilityRole="button" onPress={() => copy(requestId, "请求 ID")}
              style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}>
              <Text style={emphasizedNote}>复制请求 ID</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

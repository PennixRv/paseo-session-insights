import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Text, View, useWindowDimensions } from "react-native";
import type { AccountSnapshot } from "../shared/account.ts";
import { formatAccountTime, formatMetric } from "../shared/format.ts";
import { labels } from "../shared/metrics.ts";
import type { AccountView } from "./account-state.ts";

export function useAccount(view: AccountView, visible: boolean) {
  const reading = useSyncExternalStore(view.subscribe, view.snapshot);
  useEffect(() => {
    let active = true;
    let pending = false;
    let foreground = AppState.currentState !== "background" && AppState.currentState !== "inactive";
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (!active || !foreground || pending) return;
      pending = true;
      try {
        await view.refresh(!visible);
      } finally {
        pending = false;
        if (active && foreground) timer = setTimeout(() => { void refresh(); }, view.refreshDelay());
      }
    }
    const subscription = AppState.addEventListener("change", state => {
      foreground = state === "active";
      clearTimeout(timer);
      if (foreground) void refresh();
    });
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [view, visible]);
  return reading;
}

export const accountTitle = "ChatGPT Status";
const unavailable = "—";

export function AccountMetrics({ reading, theme, layout }: Pick<PluginSidebarItemProps, "theme" | "layout"> & {
  reading: AccountSnapshot | undefined;
}) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const stacked = (width > 0 && width / fontScale < 290);
  const { foreground, foregroundMuted, border, statusSuccess } = theme.colors;
  const ink = { color: foreground, opacity: 0.82, fontSize: 14, fontWeight: "400" as const };
  const numeric = { ...ink, fontVariant: ["tabular-nums" as const], textAlign: "right" as const };
  const note = { color: foregroundMuted, fontSize: 11 };
  if (reading?.state !== "enabled") {
    const state = reading?.state;
    return <Text style={note} accessibilityLiveRegion="polite">
      {state === "missing-key" ? "尚未配置 Sub2API Key" : state === "forbidden" ? "Sub2API 拒绝读取" :
        state === "error" ? "暂时无法读取账号指标" : "正在读取"}
    </Text>;
  }
  const { quota, subscription, today, week } = reading;
  const window = quota.data?.window;
  const cards = quota.data?.cards;
  const percent = window ? `${Number(window.used.toFixed(2))}%` : unavailable;
  const sectionLabels = ["额度与重置卡", "订阅到期", "今日", "七日"];
  const notices = [quota, subscription, today, week].flatMap(({ state }, index) =>
    state === "ready" ? [] : [`${sectionLabels[index]}${state === "stale" ? "已过期" : state === "rate-limited" ? "暂受限流" : "暂不可读"}`]);
  if (cards?.incomplete) notices.push("重置卡到期信息不完整");
  const pair = (label: string, value: string, description = value, fullWidth = false) => (
    <View key={label} accessible accessibilityLabel={`${label}，${description}`}
      style={{ flex: fullWidth || stacked ? undefined : 1, flexShrink: 0, minWidth: 0,
        flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 5 }}>
      <Text style={{ ...ink, flexShrink: 1 }}>{label}</Text>
      <Text style={numeric}>{value}</Text>
    </View>
  );
  const row = (label: string, current: string, history: string, header = false) => {
    const opacity = header ? 0.94 : ink.opacity;
    return (
      <View key={label} accessible accessibilityLabel={header ? "指标，今日，七日" : `${label}，今日 ${current}，七日 ${history}`}
        style={{ flexDirection: "row", alignItems: "baseline", gap: 5, paddingVertical: 2,
          ...(header ? { paddingTop: 5, borderColor: border, borderTopWidth: 1, borderBottomWidth: 1 } : {}) }}>
        <Text style={{ ...ink, opacity, flex: 1, minWidth: 0 }}>{label}</Text>
        <Text style={{ ...numeric, opacity, width: "30%" }}>{current}</Text>
        <Text style={{ ...numeric, opacity, width: "30%" }}>{history}</Text>
      </View>
    );
  };
  const usage = [today.data, week.data] as const;
  const rows = [
    ["Token 消耗", ...usage.map(v => v ? formatMetric("input", { state: "ready", value: v.tokens }, true) : unavailable)],
    ["账号计费", ...usage.map(v => v ? `${v.cost > 0 && v.cost < 0.01 ? "<0.01" : v.cost.toFixed(2)} USD` : unavailable)],
    ["请求数", ...usage.map(v => v ? v.requests.toLocaleString("en-US") : unavailable)],
    [labels.cache, ...usage.map(v => v?.cache == null ? unavailable : formatMetric("cache", { state: "ready", value: v.cache }))],
  ];
  const columnGap = stacked ? 3 : layout.compact ? 28 : 20;
  const pairStyle = { flexDirection: stacked ? "column" as const : "row" as const, gap: columnGap };
  return (
    <View testID="insights-account" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: 5 }}>
      {pair("七日额度", window ? `${percent} 已用` : unavailable, undefined, true)}
      <View style={{ height: 5, borderRadius: 3, backgroundColor: border, overflow: "hidden" }}>
        {window && <View style={{ height: "100%", width: `${window.used}%`, backgroundColor: statusSuccess }} />}
      </View>
      <View style={pairStyle}>
        {pair("额度重置", formatAccountTime(window?.resetAt))}
        {pair("重置卡", cards ? `${cards.count} 张` : unavailable)}
      </View>
      <View style={pairStyle}>
        {pair("最早到期", formatAccountTime(cards?.earliest), cards?.earliest ?? unavailable)}
        {pair("订阅到期", formatAccountTime(subscription.data), subscription.data ?? unavailable)}
      </View>
      {row("指标", "今日", "七日", true)}
      {rows.map(([label, current, history]) => row(label, current, history))}
      {notices.length > 0 && <Text style={note} accessibilityLiveRegion="polite">{notices.join(" · ")}</Text>}
    </View>
  );
}

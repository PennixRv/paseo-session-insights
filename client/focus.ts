import type { PluginClientContext } from "@getpaseo/plugin/client";

export function findFocusedAgent(composers: PluginClientContext["composers"], ids: Iterable<string>): string | null {
  const [focused] = composers({ focused: true });
  if (!focused) return null;
  // shortcut: Paseo 0.17.2–0.17.3 reuse handles within this API. Use a direct focused Agent ID when available.
  let match: string | null = null;
  for (const agentId of ids) {
    if (composers({ agentId })[0] !== focused) continue;
    if (match !== null) return null;
    match = agentId;
  }
  return match;
}

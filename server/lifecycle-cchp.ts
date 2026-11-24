import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createCchpReader } from "./cchp.ts";

const configSchema = z.strictObject({
  baseUrl: z.string().min(1).max(2048),
  apiKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  token: z.string().regex(/^[!-~]{1,4096}$/),
});
type GatewayConfig = z.infer<typeof configSchema>;
const run = promisify(execFile);

async function readConfig(signal: AbortSignal): Promise<GatewayConfig | null> {
  const home = resolve(process.env.PASEO_HOME || join(homedir(), ".paseo"));
  const args = ["secrets", "paseo-session-insights", "--paseo-home", home, "--private-stdout"];
  if (process.env.PASEO_SESSION_INSIGHTS_LIFECYCLE_CONFIG) {
    args.push("--config", process.env.PASEO_SESSION_INSIGHTS_LIFECYCLE_CONFIG);
  }
  const { stdout } = await run(join(homedir(), ".local", "bin", "pennix"), args, {
    signal, timeout: 2000, maxBuffer: 8192,
  });
  return stdout ? configSchema.parse(JSON.parse(stdout)) : null;
}

export function createLifecycleCchpReader(read = readConfig, fetchImpl = globalThis.fetch, clock = Date.now) {
  let cached: { expires: number; value: Promise<GatewayConfig | null> } | undefined;
  let current: { config: GatewayConfig; read: ReturnType<typeof createCchpReader> } | undefined;
  return async (threadId: string | null, signal: AbortSignal) => {
    if (!threadId || signal.aborted) return;
    const now = clock();
    if (!cached || now >= cached.expires) {
      cached = { expires: now + 15_000, value: read(signal).catch(() => null) };
    }
    const lookup = cached;
    const config = await lookup.value;
    if (lookup !== cached || signal.aborted) return;
    if (!config) {
      current = undefined;
      return;
    }
    if (!current || current.config.baseUrl !== config.baseUrl || current.config.apiKeyId !== config.apiKeyId ||
        current.config.token !== config.token) {
      current = { config, read: createCchpReader(config, fetchImpl, clock) };
    }
    const selected = current;
    const result = await selected.read(threadId, signal);
    if (current === selected && !signal.aborted) return result;
  };
}

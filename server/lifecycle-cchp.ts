import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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

const paseoHome = () => resolve(process.env.PASEO_HOME || join(homedir(), ".paseo"));
export async function runLifecycle(args: string[], signal: AbortSignal, maxBuffer: number) {
  const config = process.env.PASEO_SESSION_INSIGHTS_LIFECYCLE_CONFIG;
  if (config) {
    if (!isAbsolute(config)) throw new Error("Lifecycle config must be absolute");
    args.push("--config", config);
  }
  return (await run(join(homedir(), ".local", "bin", "pennix"), args, {
    signal, timeout: 2000, maxBuffer,
  })).stdout;
}

const localSchema = z.object({ values: z.object({
  PENNIX_COMPONENT_PASEO_CLI: z.literal("y"),
  PENNIX_PASEO_HOME: z.string(),
  PENNIX_PASEO_PLUGIN_PROFILE: z.string(),
  PENNIX_CODEX_HOME: z.string(),
}) });

export function projectLifecycleLocalSources(payload: unknown, home: string) {
  const parsed = localSchema.safeParse(payload);
  if (!parsed.success) return;
  const values = parsed.data.values;
  const configuredPath = (path: string) => {
    const expanded = path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
    if (isAbsolute(expanded) && !expanded.includes("$") && !expanded.split("/").includes("..")) {
      return resolve(expanded);
    }
  };
  const codexHome = configuredPath(values.PENNIX_CODEX_HOME);
  if (configuredPath(values.PENNIX_PASEO_HOME) !== home ||
      !configuredPath(values.PENNIX_PASEO_PLUGIN_PROFILE) || !codexHome) return;
  return { codexHome };
}

export function createLifecycleLocalReader() {
  return cacheLookup(async signal => {
    const output = await runLifecycle(["config", "check", "--json"], signal, 32 * 1024);
    return projectLifecycleLocalSources(JSON.parse(output), paseoHome()) ?? null;
  });
}

async function readConfig(signal: AbortSignal): Promise<GatewayConfig | null> {
  const stdout = await runLifecycle(["secrets", "paseo-session-insights", "--paseo-home", paseoHome(),
    "--private-stdout"], signal, 8192);
  return stdout ? configSchema.parse(JSON.parse(stdout)) : null;
}

function cacheLookup<T>(read: (signal: AbortSignal) => Promise<T | null>, clock = Date.now) {
  let cached: { expires: number; value: Promise<T | null> } | undefined;
  return async (signal: AbortSignal) => {
    if (signal.aborted) return undefined;
    const now = clock();
    if (!cached || now >= cached.expires) {
      cached = { expires: now + 15_000, value: read(signal).catch(() => null) };
    }
    const lookup = cached;
    const value = await lookup.value;
    if (lookup === cached && !signal.aborted) return value;
  };
}

export function createLifecycleCchpReader(read = readConfig, fetchImpl = globalThis.fetch, clock = Date.now) {
  const lookup = cacheLookup(read, clock);
  let current: { config: GatewayConfig; read: ReturnType<typeof createCchpReader> } | undefined;
  return async (threadId: string | null, signal: AbortSignal) => {
    if (!threadId || signal.aborted) return;
    const config = await lookup(signal);
    if (config === undefined) return;
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

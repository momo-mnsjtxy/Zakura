import type { PlatformServiceKey } from "@zakura/shared";
import type { PlatformServiceManager } from "../services/platform-services.js";
import type { PlatformServiceUsageService } from "../services/platform-service-usage.js";
import {
  serviceKeyForFetchBackend,
  serviceKeyForSearchEngine,
} from "./catalog.js";

let manager: PlatformServiceManager | null = null;
let usage: PlatformServiceUsageService | null = null;
let generation = 0;

export function bindPlatformServiceRuntime(
  m: PlatformServiceManager,
  u: PlatformServiceUsageService,
): () => void {
  const boundGeneration = ++generation;
  manager = m;
  usage = u;
  return () => {
    if (generation !== boundGeneration) return;
    generation += 1;
    manager = null;
    usage = null;
  };
}

export type ManagedResolve = {
  endpointUrl: string;
  apiKey?: string;
  serviceKey: PlatformServiceKey;
};

export async function resolveManagedForSearchEngine(
  engineId: string,
): Promise<ManagedResolve | null> {
  const key = serviceKeyForSearchEngine(engineId);
  if (!key || !manager) return null;
  const bound = manager;
  const boundGeneration = generation;
  const r = await bound.resolveManaged(key);
  if (generation !== boundGeneration || manager !== bound) return null;
  if (!r) return null;
  return { ...r, serviceKey: key };
}

export async function resolveManagedForFetchBackend(
  backendId: string,
): Promise<ManagedResolve | null> {
  const key = serviceKeyForFetchBackend(backendId);
  if (!key || !manager) return null;
  const bound = manager;
  const boundGeneration = generation;
  const r = await bound.resolveManaged(key);
  if (generation !== boundGeneration || manager !== bound) return null;
  if (!r) return null;
  return { ...r, serviceKey: key };
}

export async function consumeManagedUsage(opts: {
  tenantId: string;
  userId?: string | null;
  serviceKey: PlatformServiceKey | string;
}): Promise<void> {
  if (!usage) return;
  const bound = usage;
  const boundGeneration = generation;
  if (usage !== bound || generation !== boundGeneration) return;
  await bound.checkAndIncrement(opts);
}

export function getPlatformServiceManager(): PlatformServiceManager | null {
  return manager;
}

export function getPlatformServiceUsage(): PlatformServiceUsageService | null {
  return usage;
}

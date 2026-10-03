/**
 * In-memory deploy progress for host-level platform services.
 * Mirrors agent-progress: SSE pushes snapshots; reconnect → re-fetch GET snapshot.
 */
import type { PlatformServiceKey } from "@zakura/shared";
import { platformEvents } from "./platform-events.js";

export type ProgressLevel = "info" | "warn" | "error" | "ok";

export type PlatformServiceProgressEvent = {
  ts: number;
  level: ProgressLevel;
  step: string;
  message: string;
  percent?: number;
};

export type PlatformServiceProgressSnapshot = {
  serviceKey: string;
  /** idle | checking | pulling | creating | starting | health | stopping | done | error */
  phase: string;
  percent: number;
  running: boolean;
  done: boolean;
  error: string | null;
  message: string;
  events: PlatformServiceProgressEvent[];
  updatedAt: number;
};

const store = new Map<string, PlatformServiceProgressSnapshot>();
const MAX_EVENTS = 400;
const MAX_SERVICE_PROGRESS = 64;
export const PLATFORM_PROGRESS_STALE_MS = 30 * 60_000;

function empty(serviceKey: string, now = Date.now()): PlatformServiceProgressSnapshot {
  return {
    serviceKey,
    phase: "idle",
    percent: 0,
    running: false,
    done: false,
    error: null,
    message: "",
    events: [],
    updatedAt: now,
  };
}

function cloneSnapshot(snapshot: PlatformServiceProgressSnapshot): PlatformServiceProgressSnapshot {
  return {
    ...snapshot,
    events: snapshot.events.map((event) => ({ ...event })),
  };
}

function pruneStore(): void {
  if (store.size <= MAX_SERVICE_PROGRESS) return;
  const oldest = [...store.entries()].sort((a, b) => {
    if (a[1].running !== b[1].running) return a[1].running ? 1 : -1;
    return a[1].updatedAt - b[1].updatedAt;
  });
  for (const [key] of oldest) {
    if (store.size <= MAX_SERVICE_PROGRESS) break;
    store.delete(key);
  }
}

function save(serviceKey: string, snapshot: PlatformServiceProgressSnapshot): void {
  store.set(serviceKey, snapshot);
  pruneStore();
}

function publish(serviceKey: string): void {
  const snapshot = store.get(serviceKey) ?? empty(serviceKey);
  platformEvents.publishAll({
    type: "platform_service_progress",
    serviceKey,
    snapshot: cloneSnapshot(snapshot),
  });
}

export function getPlatformServiceProgress(
  serviceKey: string,
  opts: { now?: number; staleAfterMs?: number } = {},
): PlatformServiceProgressSnapshot {
  const now = opts.now ?? Date.now();
  const current = store.get(serviceKey);
  if (!current) return empty(serviceKey, now);
  if (
    current.running &&
    now - current.updatedAt > (opts.staleAfterMs ?? PLATFORM_PROGRESS_STALE_MS)
  ) {
    const message = "deployment progress became stale; reconcile service state";
    const staleEvent: PlatformServiceProgressEvent = {
      ts: now,
      level: "error",
      step: "stale",
      message,
      percent: current.percent,
    };
    const stale: PlatformServiceProgressSnapshot = {
      ...current,
      phase: "error",
      running: false,
      done: true,
      error: message,
      message,
      events: [
        ...current.events,
        staleEvent,
      ].slice(-MAX_EVENTS),
      updatedAt: now,
    };
    save(serviceKey, stale);
    publish(serviceKey);
    return cloneSnapshot(stale);
  }
  return cloneSnapshot(current);
}

export function beginPlatformServiceProgress(
  serviceKey: PlatformServiceKey | string,
  phase = "checking",
  message = "准备中…",
  opts: { now?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  save(serviceKey, {
    ...empty(serviceKey, now),
    phase,
    message,
    running: true,
    percent: 2,
    updatedAt: now,
  });
  publish(serviceKey);
}

export function logPlatformServiceProgress(
  serviceKey: string,
  step: string,
  message: string,
  opts?: { level?: ProgressLevel; percent?: number; phase?: string; now?: number },
): void {
  const cur = store.get(serviceKey) ?? empty(serviceKey);
  const now = opts?.now ?? Date.now();
  const percent =
    opts?.percent !== undefined
      ? Math.max(0, Math.min(100, opts.percent))
      : cur.percent;
  const event: PlatformServiceProgressEvent = {
    ts: now,
    level: opts?.level ?? "info",
    step,
    message,
    percent,
  };
  save(serviceKey, {
    ...cur,
    phase: opts?.phase ?? cur.phase,
    percent,
    // Keep last human-readable status line short; full trail is events
    message: message.slice(0, 500),
    running: true,
    done: false,
    error: null,
    events: [...cur.events, event].slice(-MAX_EVENTS),
    updatedAt: now,
  });
  publish(serviceKey);
}

/** Append a raw docker/engine log line (no canned copy). */
export function appendPlatformServiceLog(
  serviceKey: string,
  line: string,
  opts?: {
    step?: string;
    level?: ProgressLevel;
    phase?: string;
    percent?: number;
    now?: number;
  },
): void {
  const text = line.replace(/\r/g, "").trimEnd();
  if (!text.trim()) return;
  // Split multi-line blobs into individual events
  for (const part of text.split("\n")) {
    const msg = part.trimEnd();
    if (!msg.trim()) continue;
    logPlatformServiceProgress(serviceKey, opts?.step ?? "log", msg, {
      level: opts?.level ?? "info",
      phase: opts?.phase,
      percent: opts?.percent,
      now: opts?.now,
    });
  }
}

export function setPlatformServicePhase(
  serviceKey: string,
  phase: string,
  percent?: number,
  opts: { now?: number } = {},
): void {
  const cur = store.get(serviceKey) ?? empty(serviceKey);
  save(serviceKey, {
    ...cur,
    phase,
    percent: percent ?? cur.percent,
    running: true,
    done: false,
    updatedAt: opts.now ?? Date.now(),
  });
  publish(serviceKey);
}

export function finishPlatformServiceProgress(
  serviceKey: string,
  opts?: { error?: string | null; message?: string; now?: number },
): void {
  const cur = store.get(serviceKey) ?? empty(serviceKey);
  const error = opts?.error ?? null;
  const now = opts?.now ?? Date.now();
  const finalEvent: PlatformServiceProgressEvent = {
    ts: now,
    level: error ? "error" : "ok",
    step: error ? "error" : "done",
    message: opts?.message ?? (error ? error : "完成"),
    percent: 100,
  };
  save(serviceKey, {
    ...cur,
    phase: error ? "error" : "done",
    percent: 100,
    running: false,
    done: true,
    error,
    message: opts?.message ?? (error ? error : "完成"),
    events: [...cur.events, finalEvent].slice(-MAX_EVENTS),
    updatedAt: now,
  });
  publish(serviceKey);
}

export function clearPlatformServiceProgress(serviceKey?: string): void {
  if (serviceKey) store.delete(serviceKey);
  else store.clear();
}

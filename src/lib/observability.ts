export type PerformanceObservationName =
  | "db.execute"
  | "db.select"
  | "download-cache.backfill"
  | "scheduler.event"
  | "scheduler.snapshot"
  | "update.download";

export interface PerformanceObservation {
  details: Record<string, unknown>;
  durationMs?: number;
  name: PerformanceObservationName;
  time: number;
}

type PerformanceObservationListener = (
  observation: PerformanceObservation,
) => void;

const performanceObservationListeners =
  new Set<PerformanceObservationListener>();

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function recordPerformanceObservation(
  name: PerformanceObservationName,
  details: Record<string, unknown> = {},
  startedAt?: number,
): void {
  if (performanceObservationListeners.size === 0) return;

  const time = now();
  const observation: PerformanceObservation = {
    details,
    name,
    time,
    ...(startedAt === undefined ? {} : { durationMs: time - startedAt }),
  };
  for (const listener of performanceObservationListeners) {
    try {
      listener(observation);
    } catch {
      // Observability listeners must not affect the runtime path.
    }
  }
}

export function startPerformanceObservation(
  name: PerformanceObservationName,
  details: Record<string, unknown> = {},
): (details?: Record<string, unknown>) => void {
  const startedAt = now();
  return (finishDetails: Record<string, unknown> = {}) => {
    recordPerformanceObservation(
      name,
      { ...details, ...finishDetails },
      startedAt,
    );
  };
}

export function subscribePerformanceObservations(
  listener: PerformanceObservationListener,
): () => void {
  performanceObservationListeners.add(listener);
  return () => {
    performanceObservationListeners.delete(listener);
  };
}

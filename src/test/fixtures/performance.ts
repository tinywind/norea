import type { TaskPriority, TaskSource } from "../../lib/tasks/scheduler";

export interface SyntheticSourceTaskFixture {
  priority: TaskPriority;
  source: TaskSource;
  title: string;
}

export function buildSyntheticSourceTasks(
  count: number,
): SyntheticSourceTaskFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    priority: "background",
    source: {
      id: `source-${index}`,
      name: `Source ${index}`,
    },
    title: `Synthetic task ${index}`,
  }));
}

export function buildSyntheticArrayBuffer(byteLength: number): ArrayBuffer {
  const bytes = new Uint8Array(Math.max(0, byteLength));
  return bytes.buffer;
}

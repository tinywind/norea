import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskScheduler, type TaskSpec } from "./scheduler";

let scheduler: TaskScheduler;
const spec = (run: TaskSpec<void>["run"], key: string, automatic?: boolean) => ({
  kind: "chapter.download" as const, title: key, source: { id: "source", name: "Source" },
  dedupeKey: key, priority: "background" as const, ...(automatic ? { automatic } : {}), run,
});
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1, sourceQueuesPaused: false });
});
afterEach(() => { vi.useRealTimers(); });

it("holds queued goal work while automatic downloads are paused and lets explicit work run", async () => {
  scheduler.setAutomaticWorkPaused(true);
  const goal = vi.fn(async () => undefined);
  const explicit = vi.fn(async () => undefined);
  const goalHandle = scheduler.enqueueSource(spec(goal, "goal", true));
  scheduler.enqueueSource(spec(explicit, "explicit"));
  await settle();

  expect(explicit).toHaveBeenCalledOnce();
  expect(goal).not.toHaveBeenCalled();
  expect(scheduler.getTask(goalHandle.id)).toMatchObject({ status: "queued", automatic: true });

  scheduler.setAutomaticWorkPaused(false);
  await settle();
  expect(goal).toHaveBeenCalledOnce();
});

it("treats a goal chapter as explicit once the user asks for it", async () => {
  scheduler.setAutomaticWorkPaused(true);
  const run = vi.fn(async () => undefined);
  const handle = scheduler.enqueueSource(spec(run, "chapter", true));
  await settle();
  expect(run).not.toHaveBeenCalled();

  expect(scheduler.enqueueSource({ ...spec(run, "chapter"), priority: "user" }).id).toBe(handle.id);
  await settle();

  expect(run).toHaveBeenCalledOnce();
  expect(scheduler.getTask(handle.id)?.automatic).toBeUndefined();
});

it("runs server-lane chapters beside the source's serial work and hands a miss to the same task's source route", async () => {
  const executors: string[] = [];
  let finishSource!: () => void;
  scheduler.enqueueSource(spec(({ executor }) => {
    executors.push(`source:${executor}`);
    return new Promise<void>((resolve) => { finishSource = resolve; });
  }, "busy-source"));
  await settle();
  let attempts = 0;
  const handle = scheduler.enqueueSource({
    ...spec(async ({ executor, tryStartSourceAccess }) => {
      attempts += 1;
      executors.push(`lane:${executor}`);
      if (executor?.startsWith("server:") && !tryStartSourceAccess!()) return;
    }, "server-copy"),
    canCompleteWithoutSourceAccess: true,
    serverLane: true,
  });
  await settle();

  expect(executors).toEqual(["source:pool:0", "lane:server:0"]);
  expect(scheduler.getTask(handle.id)?.status).toBe("queued");

  finishSource();
  await settle();
  await settle();
  expect(executors).toEqual(["source:pool:0", "lane:server:0", "lane:pool:0"]);
  expect(attempts).toBe(2);
  await expect(handle.promise).resolves.toBeUndefined();
});

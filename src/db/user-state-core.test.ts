import { expect, it, vi } from "vitest";
import {
  installUserStateDeferredRunner,
  notifyUserStateCommitted,
  requestUserStateDeferredApply,
  waitForUserStateDeferredApply,
  type UserStateDb,
} from "./user-state-core";

it("replays a projection request committed while the background runner is active", async () => {
  const db = {} as UserStateDb;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  let calls = 0;

  installUserStateDeferredRunner(async () => {
    calls += 1;
    if (calls === 1) {
      firstStarted();
      await new Promise<void>(resolve => { releaseFirst = resolve; });
    }
  });

  requestUserStateDeferredApply(db);
  notifyUserStateCommitted(db);
  await started;
  expect(calls).toBe(1);

  requestUserStateDeferredApply(db);
  notifyUserStateCommitted(db);
  releaseFirst();

  await waitForUserStateDeferredApply();
  expect(calls).toBe(2);
  await vi.waitFor(() => expect(calls).toBe(2));
});

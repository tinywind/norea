import { beforeEach, expect, it } from "vitest";
import { useUpdatesSeenStore } from "./updates-seen";

beforeEach(() => { useUpdatesSeenStore.setState({ updatesSeenAt: 0 }); });

it("only moves the seen time forward", () => {
  useUpdatesSeenStore.getState().markUpdatesSeen(500);
  useUpdatesSeenStore.getState().markUpdatesSeen(300);
  expect(useUpdatesSeenStore.getState().updatesSeenAt).toBe(500);
});

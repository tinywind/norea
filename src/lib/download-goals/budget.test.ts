import { expect, it } from "vitest";
import { automaticDownloadPause, MIN_AUTOMATIC_DOWNLOAD_FREE_BYTES } from "./budget";

const idle = { metered: false, powerSave: false, freeBytes: null };
const pause = (overrides: Partial<Parameters<typeof automaticDownloadPause>[0]>) => automaticDownloadPause({
  heldAfterRestore: false, status: idle, allowMobileData: false, allowedOnce: false, ...overrides,
});

it("pauses automatic work for a restore, low storage, mobile data or battery saver, in that order", () => {
  expect(pause({})).toBeNull();
  expect(pause({ heldAfterRestore: true, status: { metered: true, powerSave: true, freeBytes: 1 } })).toBe("restore");
  expect(pause({ status: { metered: true, powerSave: true, freeBytes: MIN_AUTOMATIC_DOWNLOAD_FREE_BYTES - 1 } })).toBe("storage");
  expect(pause({ status: { metered: true, powerSave: true, freeBytes: MIN_AUTOMATIC_DOWNLOAD_FREE_BYTES } })).toBe("metered");
  expect(pause({ status: { ...idle, powerSave: true } })).toBe("battery");
});

it("lets mobile data and Allow once lift the network budget but never the storage budget", () => {
  expect(pause({ status: { ...idle, metered: true }, allowMobileData: true })).toBeNull();
  expect(pause({ status: { ...idle, metered: true, powerSave: true }, allowedOnce: true })).toBeNull();
  expect(pause({ status: { ...idle, freeBytes: 5 }, allowedOnce: true })).toBe("storage");
});

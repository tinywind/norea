import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pageActive: true,
  effects: [] as Array<{ effect: () => void | (() => void); deps?: readonly unknown[] }>,
  clearResolved: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    mocks.effects.push({ effect, deps });
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ removeQueries: vi.fn(), invalidateQueries: vi.fn() }),
}));
vi.mock("../../i18n", () => ({
  formatDateTimeForLocale: () => "",
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../ui/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(),
}));
vi.mock("../../lib/page-activity", () => ({
  usePageActivity: () => mocks.pageActive,
}));
vi.mock("../../lib/tasks/sync-runtime", () => ({
  clearResolvedOpenedSyncBackgroundFailures: mocks.clearResolved,
}));
vi.mock("./DownloadsSection", () => ({
  reconcileChapterStorage: vi.fn(),
}));

import { BackupSection } from "./BackupSection";

function runEffectLifecycle(initialActive: boolean) {
  let cleanup: (() => void) | undefined;
  let lastDeps: readonly unknown[] | undefined;

  const render = (active: boolean) => {
    mocks.pageActive = active;
    mocks.effects = [];
    BackupSection({ busyAction: null, isBusy: false, onBusyChange: vi.fn() });
    expect(mocks.effects).toHaveLength(1);
    const { effect, deps } = mocks.effects[0]!;
    const depsChanged =
      lastDeps === undefined ||
      deps === undefined ||
      deps.length !== lastDeps.length ||
      deps.some((value, index) => !Object.is(value, lastDeps![index]));
    if (depsChanged) {
      cleanup?.();
      cleanup = undefined;
      const next = effect();
      cleanup = typeof next === "function" ? next : undefined;
      lastDeps = deps;
    }
  };

  render(initialActive);
  return {
    rerender: render,
    unmount: () => {
      cleanup?.();
      cleanup = undefined;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pageActive = true;
  mocks.effects = [];
});

it("clears resolved background sync failures when the persistent settings slot becomes inactive", () => {
  const mounted = runEffectLifecycle(false);
  expect(mocks.clearResolved).not.toHaveBeenCalled();

  // Opening Backup & sync from a notification activates the persistent slot without clearing yet.
  mounted.rerender(true);
  expect(mocks.clearResolved).not.toHaveBeenCalled();

  // Leaving Settings to another top-level tab hides the slot without unmounting BackupSection.
  mounted.rerender(false);
  expect(mocks.clearResolved).toHaveBeenCalledTimes(1);

  // Unmounting while already inactive does not double-clear.
  mounted.unmount();
  expect(mocks.clearResolved).toHaveBeenCalledTimes(1);
});

it("clears resolved background sync failures when switching away from Backup & sync while active", () => {
  const mounted = runEffectLifecycle(true);
  expect(mocks.clearResolved).not.toHaveBeenCalled();

  mounted.unmount();
  expect(mocks.clearResolved).toHaveBeenCalledTimes(1);
});

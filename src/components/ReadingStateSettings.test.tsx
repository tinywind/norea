import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { UserStateStatus } from "../lib/user-state/types";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), resume: vi.fn(), refetch: vi.fn(), setEnabled: vi.fn(),
  status: { workspaceId: "workspace", lastSuccessAt: null } as UserStateStatus,
  statusError: null as Error | null,
  store: {
    enabledByServer: {} as Record<string, true>,
    runtimeByServer: {} as Record<string, { phase: "idle" | "syncing" | "error"; error: string | null; revision: number }>,
  },
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => queryKey[0] === "device"
    ? { data: "This tablet" }
    : { data: mocks.status, refetch: mocks.refetch, isFetching: false, error: mocks.statusError },
}));
vi.mock("../i18n", async () => {
  const { default: messages } = await import("../../strings/languages/en/app.json");
  const translate = (key: keyof typeof messages, values?: Record<string, string | number>) => {
    let text = messages[key];
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll("{" + name + "}", String(value));
    return text;
  };
  return { useTranslation: () => ({ locale: "en", t: translate }), formatDateTimeForLocale: (_locale: string, value: number) => String(value) };
});
vi.mock("../store/content-sync", () => ({
  useContentSyncStore: (selector: (state: { deviceName: string }) => unknown) => selector({ deviceName: "Tablet" }),
}));
vi.mock("../store/user-state", () => ({
  USER_STATE_IDLE_RUNTIME: { phase: "idle", error: null, revision: 0 },
  useUserStateStore: (selector: (state: object) => unknown) => selector({ ...mocks.store, setEnabled: mocks.setEnabled }),
}));
vi.mock("../db/user-state", () => ({ subscribeUserStateLedgerChanges: vi.fn(() => () => {}) }));
vi.mock("../lib/user-state/sync", () => ({
  getUserStateStatus: vi.fn(), synchronizeUserState: mocks.sync, resumeUserStateAfterRestore: mocks.resume,
}));
import { ReadingStateSettings } from "./ReadingStateSettings";
import { useTranslation } from "../i18n";

interface Props {
  children?: ReactNode; label?: string; "aria-label"?: string; onClick?: () => void;
  disabled?: boolean; checked?: boolean; loading?: boolean; status?: string; error?: ReactNode;
  onChange?: (event: { currentTarget: { checked: boolean } }) => void;
}
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
function view(serverUrl = "https://server.example") {
  return controls(ReadingStateSettings({ serverUrl }));
}
function visibleCopy(elements: ReactElement<Props>[]) {
  return elements.flatMap(({ props }) => [
    props.label, props.status, props.error,
    typeof props.children === "string" ? props.children : undefined,
  ]).filter(value => typeof value === "string").join(" ");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = { workspaceId: "workspace", lastSuccessAt: null } as UserStateStatus;
  mocks.statusError = null;
  mocks.store.enabledByServer = {};
  mocks.store.runtimeByServer = {};
  mocks.sync.mockResolvedValue(undefined);
  mocks.resume.mockResolvedValue(undefined);
  mocks.refetch.mockResolvedValue({});
});

it("offers manual sharing while automatic sharing starts off, without device replacement controls", async () => {
  const elements = view();
  expect(elements.find(item => item.props["aria-label"] === "Share automatically")?.props.checked).toBe(false);
  const sync = elements.find(item => item.props.label === "Sync now" && item.props.onClick)!;
  expect(sync.props.disabled).toBe(false);
  expect(elements.some(item => item.props.label?.includes("Restore device backup"))).toBe(false);
  sync.props.onClick!();
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
});

it("requires the explicit reconnect action after a portable restore", async () => {
  mocks.status.pausedAfterRestore = true;
  const elements = view();
  expect(elements.find(item => item.props.label === "Sync now" && item.props.onClick)?.props.disabled).toBe(true);
  expect(elements.find(item => item.props["aria-label"] === "Share automatically")?.props.disabled).toBe(true);
  const reconnect = elements.find(item => item.props.children === "Reconnect to the existing shared state")!;
  reconnect.props.onClick!();
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("only changes the selected server's automatic sharing preference", () => {
  const toggle = view().find(item => item.props["aria-label"] === "Share automatically")!;
  toggle.props.onChange!({ currentTarget: { checked: true } });
  expect(mocks.setEnabled).toHaveBeenCalledWith("https://server.example", true);
  for (const control of view("").filter(item => item.props.label === "Sync now" && item.props.onClick)) expect(control.props.disabled).toBe(true);
});

it("keeps large retained legacy diagnostics out of the settings screen", () => {
  const work = { pluginId: "test", sourceNovelId: "42", novelPath: "/work/42", name: "Retained work" };
  Object.assign(mocks.status, {
    pending: 5505,
    conflicts: Array.from({ length: 100 }, (_, index) => ({ id: String(index), reason: "legacy-conflict" })),
    deferred: Array.from({ length: 1674 }, (_, index) => ({
      id: String(index), entity: { kind: "reading", work, chapter: { chapterPath: "/chapter/" + index, name: "Diagnostic chapter " + index } },
      reason: "missing-chapter",
    })),
    conflictCount: 100, deferredCount: 1674,
    deferredReasons: [{ reason: "missing-chapter", count: 1674 }],
  });
  const elements = view();
  const copy = visibleCopy(elements);
  expect(elements.length).toBeLessThan(60);
  expect(copy).not.toMatch(/5505|1674|Diagnostic chapter|legacy-conflict|missing-chapter|Retained work/);
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("shows one active sharing status and prevents duplicate manual requests", () => {
  mocks.store.runtimeByServer["https://server.example"] = { phase: "syncing", error: null, revision: 1 };
  const elements = view();
  const { t } = useTranslation();
  expect(elements.filter(item => item.props.status === t("userState.syncing"))).toHaveLength(1);
  const sync = elements.find(item => item.props.label === "Sync now" && item.props.onClick)!;
  expect(sync.props.loading).toBe(true);
  expect(sync.props.disabled).toBe(true);
});

it("shows the last completed share without exposing operation counts", () => {
  mocks.status.lastSuccessAt = 1234;
  const { t } = useTranslation();
  expect(view().some(item => item.props.status === t("userState.lastSuccess", { time: "1234" }))).toBe(true);
});

it("keeps a failed share visible and leaves manual retry available", () => {
  mocks.store.runtimeByServer["https://server.example"] = { phase: "error", error: "Connection timed out", revision: 1 };
  const elements = view();
  expect(elements.some(item => item.props.error === "Connection timed out")).toBe(true);
  expect(elements.find(item => item.props.label === "Sync now" && item.props.onClick)?.props.disabled).toBe(false);
});

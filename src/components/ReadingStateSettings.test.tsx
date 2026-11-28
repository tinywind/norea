import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { UserStateConflict, UserStateStatus } from "../lib/user-state/types";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), resume: vi.fn(), resolve: vi.fn(), rebind: vi.fn(), refetch: vi.fn(), setEnabled: vi.fn(), setRetention: vi.fn(),
  categoryName: undefined as string | undefined,
  status: { workspaceId: "workspace", epoch: "epoch", pending: 2, conflicts: [], lastSuccessAt: null } as UserStateStatus,
  store: { enabledByServer: {} as Record<string, true>, runtimeByServer: {} as Record<string, Record<string, unknown>> },
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (initial: unknown) => [typeof initial === "string" ? mocks.categoryName ?? initial : initial, vi.fn()],
  useEffect: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => queryKey[0] === "device"
    ? { data: "This tablet" }
    : { data: mocks.status, refetch: mocks.refetch, isFetching: false, error: null },
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
  useUserStateStore: (selector: (state: object) => unknown) => selector({ ...mocks.store, setEnabled: mocks.setEnabled, setRetention: mocks.setRetention }),
}));
vi.mock("../db/user-state", () => ({ subscribeUserStateLedgerChanges: vi.fn(() => () => {}) }));
vi.mock("../lib/user-state/sync", () => ({
  getUserStateStatus: vi.fn(), synchronizeUserState: mocks.sync, resumeUserStateAfterRestore: mocks.resume, resolveUserStateConflict: mocks.resolve, rebindUserStateWorkspace: mocks.rebind,
}));
import { ReadingStateSettings, userStateValueSummary } from "./ReadingStateSettings";
import { useTranslation } from "../i18n";
import { formatUserStateErrorSummary } from "../lib/content-sync/error-summary";

interface Props {
  children?: ReactNode; label?: string; "aria-label"?: string; onClick?: () => void;
  disabled?: boolean; checked?: boolean; conflict?: UserStateConflict;
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
function conflictView(conflict: UserStateConflict) {
  mocks.status.conflicts = [conflict];
  const card = view().find(element => element.props.conflict)!;
  return controls((card.type as (props: Props) => ReactNode)(card.props));
}
const work = { pluginId: "test-source", sourceNovelId: "42", novelPath: "/work/42", name: "A saved work" };
const categoryConflict = (): UserStateConflict => ({
  id: "conflict-1", version: "shown-version", entity: { kind: "category", categoryId: "local-category" },
  local: { name: "Favorites", sort: 0, deleted: false }, reason: "category-name-conflict",
  shared: { entity: { kind: "category", categoryId: "existing-category" }, value: { name: "Favorites", sort: 1, deleted: false },
    revision: 12, operationId: "shared-op", updatedAt: 1000, deviceId: "other-device", deviceName: "Other tablet" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.categoryName = undefined;
  mocks.status = { workspaceId: "workspace", epoch: "epoch", pending: 2, conflicts: [], lastSuccessAt: null };
  mocks.store.enabledByServer = {};
  mocks.store.runtimeByServer = {};
  mocks.sync.mockResolvedValue(undefined);
  mocks.resume.mockResolvedValue(undefined);
  mocks.resolve.mockResolvedValue(undefined);
  mocks.rebind.mockResolvedValue(undefined);
  mocks.refetch.mockResolvedValue({});
});

it("offers manual merging while automatic sharing starts off, without snapshot replacement controls", async () => {
  const elements = view();
  expect(elements.find(item => item.props["aria-label"] === "Share automatically")?.props.checked).toBe(false);
  const sync = elements.find(item => item.props.children === "Sync" && item.props.onClick)!;
  expect(sync.props.disabled).toBe(false);
  expect(elements.some(item => item.props.label?.includes("Restore device backup"))).toBe(false);
  sync.props.onClick!();
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
});

it("requires the explicit reconnect action after a portable restore", async () => {
  mocks.status.pausedAfterRestore = true;
  const elements = view();
  expect(elements.find(item => item.props.children === "Sync" && item.props.onClick)?.props.disabled).toBe(true);
  expect(elements.find(item => item.props["aria-label"] === "Share automatically")?.props.disabled).toBe(true);
  expect(elements.some(item => typeof item.props.children === "string" &&
    item.props.children.includes("Shared information may update restored values"))).toBe(true);
  const reconnect = elements.find(item => item.props.children === "Reconnect to the existing shared state")!;
  reconnect.props.onClick!();
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("only changes the selected server's automatic sharing preference", () => {
  const toggle = view().find(item => item.props["aria-label"] === "Share automatically")!;
  toggle.props.onChange!({ currentTarget: { checked: true } });
  expect(mocks.setEnabled).toHaveBeenCalledWith("https://server.example", true);
  for (const control of view("").filter(item => item.props.children === "Sync" && item.props.onClick)) expect(control.props.disabled).toBe(true);
});

it("shows outstanding local projection and failures separately from uploads", () => {
  mocks.status = { ...mocks.status, pending: 0, projectionPending: 2, projectionFailed: 1 };
  const elements = view();
  expect(elements.some(item => item.props.children === "Local projection: 2 pending · 1 failed")).toBe(true);
});

it("keeps negative reading and bookmark edits readable instead of hiding them as absent values", () => {
  const { t } = useTranslation();
  expect(userStateValueSummary("reading", { progress: 0, readAt: null }, t, "en")).toBe("0% · Unread · No reading history");
  expect(userStateValueSummary("bookmark", { bookmarked: false }, t, "en")).toBe("Bookmark removed");
  expect(userStateValueSummary("resume", { chapter: null, anchor: null, openedAt: null }, t, "en")).toBe("Continue-reading position cleared");
  expect(userStateValueSummary("library", { inLibrary: false, addedAt: null }, t, "en")).toBe("Removed from the library");
});

it("requires a different name for a category-name collision", async () => {
  let elements = conflictView(categoryConflict());
  expect(elements.find(item => item.props.children === "Keep this device's edit")?.props.disabled).toBe(true);
  mocks.categoryName = "Reading next";
  elements = conflictView(categoryConflict());
  const keep = elements.find(item => item.props.children === "Keep this device's edit")!;
  expect(keep.props.disabled).toBe(false);
  keep.props.onClick!();
  await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith({
    conflictId: "conflict-1", version: "shown-version", choice: "local", categoryName: "Reading next",
  }));
});

it("passes only the displayed conflict version when the shared category is selected", async () => {
  const shared = conflictView(categoryConflict()).find(item => item.props.children === "Use the shared edit")!;
  shared.props.onClick!();
  await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith({
    conflictId: "conflict-1", version: "shown-version", choice: "shared",
  }));
});

it("offers category recreation and retaining deletion as distinct resolution actions", () => {
  const conflict = categoryConflict();
  conflict.reason = "category-deleted";
  conflict.shared!.value = { name: "Favorites", sort: 0, deleted: true };
  const elements = conflictView(conflict);
  expect(elements.some(item => item.props.children === "Recreate the category")).toBe(true);
  expect(elements.some(item => item.props.children === "Keep the shared deletion")).toBe(true);
});

it("labels category restoration before including a work in a deleted category", async () => {
  const conflict: UserStateConflict = {
    id: "membership-conflict", version: "membership-version", categoryName: "Favorites",
    entity: { kind: "membership", work, categoryId: "category" },
    local: { included: true }, shared: null, reason: "category-deleted",
  };
  const elements = conflictView(conflict);
  expect(elements.some(item => item.props.children === "Recreate the deleted category and include this work.")).toBe(true);
  const restore = elements.find(item => item.props.children === "Restore category membership")!;
  expect(restore.props.disabled).toBe(false);
  restore.props.onClick!();
  await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith({
    conflictId: "membership-conflict", version: "membership-version", choice: "local", categoryName: "Favorites",
  }));
});

it("shows only synchronization work, not local content projection backlog", () => {
  const elements = view();
  expect(elements.some(item => item.props.children === "Changes waiting to be applied")).toBe(false);
  expect(elements.some(item => item.props.children === "Pending: 2 · Conflicts: 0")).toBe(true);
});

it("renders Mode A and Mode B rebind buttons when epochMismatch is active and triggers rebindUserStateWorkspace", async () => {
  mocks.status.epochMismatch = {
    serverUrl: "https://server.example",
    localWorkspaceId: "workspace",
    localEpoch: "epoch",
    serverWorkspaceId: "workspace",
    serverEpoch: "epoch-2",
    headRevision: 5,
    detectedAt: 1000,
  };
  mocks.status.seedCutoffAt = 1_700_000_000_000;
  const elements = view();
  const reseed = elements.find(item => item.props.children === "Re-seed local state")!;
  const fresh = elements.find(item => item.props.children === "Start fresh")!;
  const syncNow = elements.find(item => item.props.children === "Sync" && item.props.onClick)!;
  expect(reseed.props.disabled).toBe(false);
  expect(fresh.props.disabled).toBe(false);
  expect(syncNow.props.disabled).toBe(true);
  expect(elements.some(item => typeof item.props.children === "string" && item.props.children.includes("Server retains reading history since"))).toBe(true);

  reseed.props.onClick!();
  await vi.waitFor(() => expect(mocks.rebind).toHaveBeenCalledWith("reseed"));
  fresh.props.onClick!();
  await vi.waitFor(() => expect(mocks.rebind).toHaveBeenCalledWith("start_fresh"));

  mocks.status.pausedAfterRestore = true;
  const pausedElements = view();
  expect(pausedElements.find(item => item.props.children === "Re-seed local state")?.props.disabled).toBe(true);
  expect(pausedElements.find(item => item.props.children === "Start fresh")?.props.disabled).toBe(true);
});

it("keeps client retention controls disabled by default and forwards explicit opt-in toggles", () => {
  const elements = view();
  const pruneSwitch = elements.find(item => item.props["aria-label"] === "Prune non-library reading history")!;
  const stripSwitch = elements.find(item => item.props["aria-label"] === "Strip old reading timestamps")!;
  expect(pruneSwitch.props.checked).toBe(false);
  expect(stripSwitch.props.checked).toBe(false);

  pruneSwitch.props.onChange!({ currentTarget: { checked: true } });
  expect(mocks.setRetention).toHaveBeenCalledWith("https://server.example", { pruneNonLibraryEnabled: true });
  stripSwitch.props.onChange!({ currentTarget: { checked: true } });
  expect(mocks.setRetention).toHaveBeenCalledWith("https://server.example", { stripTimestampsEnabled: true });
});

it("displays background and blocked user-state failures identically to the notification summary", () => {
  const { t } = useTranslation();
  mocks.store.runtimeByServer["https://server.example"] = {
    phase: "idle",
    error: null,
    backgroundError: "Server temporarily unavailable",
    backgroundBlocked: false,
    revision: 1,
  };
  const syncRow = () =>
    view().find(item => item.props.label === "Reading information" && "error" in (item.props as Record<string, unknown>));
  expect((syncRow()?.props as { error?: string } | undefined)?.error).toBe(
    formatUserStateErrorSummary("Server temporarily unavailable", false, t),
  );

  mocks.store.runtimeByServer["https://server.example"] = {
    phase: "idle",
    error: null,
    backgroundError: "HTTP 403",
    backgroundBlocked: true,
    revision: 2,
  };
  expect((syncRow()?.props as { error?: string } | undefined)?.error).toBe(
    formatUserStateErrorSummary("HTTP 403", true, t),
  );
});

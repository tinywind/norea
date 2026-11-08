import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  save: vi.fn(), navigate: vi.fn(), sync: vi.fn(), invalidate: vi.fn(),
  defaultName: "TB320FC" as string | undefined, refetchName: vi.fn(),
  stateIndex: 0,
  stateSlots: [] as unknown[],
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.stateSlots)) mocks.stateSlots[index] = index === 0 ? "http://new-server" : initial;
    return [mocks.stateSlots[index], (value: unknown) => { mocks.stateSlots[index] = value; }];
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: () => ({ data: mocks.defaultName, refetch: mocks.refetchName }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../store/content-sync", () => ({ useContentSyncStore: (select: (state: Record<string, unknown>) => unknown) => select(mocks.state) }));
vi.mock("../lib/content-sync/sync", () => ({ syncContentServer: mocks.sync }));

import { ContentServerSettings } from "./ContentServerSettings";

interface ControlProps { children?: ReactNode; onClick?: () => void; onChange?: (value: number | string) => void; onBlur?: () => void; value?: unknown; disabled?: boolean; label?: string; "aria-label"?: string }
function controls(node: ReactNode): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ControlProps>;
  return [element, ...controls(element.props.children)];
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.stateIndex = 0; mocks.stateSlots = [];
  mocks.defaultName = "TB320FC";
  mocks.refetchName.mockResolvedValue({ data: "TB320FC" });
  mocks.state = { serverUrl: "http://server", deviceName: "Phone", syncMode: "manual", syncIntervalMinutes: 15,
    lookupTimeoutSeconds: 3, setLookupTimeoutSeconds: vi.fn(),
    uploadConflictPolicy: "prefer-complete", setUploadConflictPolicy: vi.fn(),
    status: "syncing", error: null, blocked: false, setServerUrl: mocks.save,
    setDeviceName: vi.fn(), setSyncMode: vi.fn(), setSyncIntervalMinutes: vi.fn() };
});

it("lets the user choose upload conflict handling without starting a sync", () => {
  const policy = controls(ContentServerSettings()).find(element => element.props["aria-label"] === "contentSync.uploadConflictPolicy");
  expect(policy).toBeDefined();
  expect(policy!.props.value).toBe("prefer-complete");
  policy!.props.onChange!("replace-server");
  expect(mocks.state.setUploadConflictPolicy).toHaveBeenCalledWith("replace-server");
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("shows the system name without a configured server and keeps custom names while it loads", () => {
  mocks.state.serverUrl = "";
  mocks.state.deviceName = "";
  expect(controls(ContentServerSettings()).find(element => element.props["aria-label"] === "contentSync.deviceName")!.props.value).toBe("TB320FC");
  mocks.state.deviceName = "My tablet";
  mocks.defaultName = undefined;
  expect(controls(ContentServerSettings()).find(element => element.props["aria-label"] === "contentSync.deviceName")!.props.value).toBe("My tablet");
});

it("resets a custom name to the current system default without synchronizing", async () => {
  const reset = controls(ContentServerSettings()).find(element => element.props.label === "contentSync.resetDeviceName");
  expect(reset).toBeDefined();
  reset!.props.onClick!();
  await Promise.resolve();
  expect(mocks.refetchName).toHaveBeenCalledWith({ throwOnError: true });
  expect(mocks.state.setDeviceName).toHaveBeenCalledWith("");
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("exposes the three-second server lookup deadline while background sync is running", () => {
  const timeout = controls(ContentServerSettings()).find(element => element.props["aria-label"] === "contentSync.lookupTimeout")!;
  expect(timeout.props.value).toBe(3);
  timeout.props.onChange!(8);
  expect(mocks.state.setLookupTimeoutSeconds).toHaveBeenCalledWith(8);
});

it("saves a connection without refreshing unrelated plugin and library queries", async () => {
  const elements = controls(ContentServerSettings());
  elements.find(element => element.props.label === "contentSync.saveServerUrl")!.props.onClick!();
  await Promise.resolve();
  expect(mocks.save).toHaveBeenCalledWith("http://new-server");
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

it("keeps connection editing and server browsing available during background synchronization", () => {
  const elements = controls(ContentServerSettings());
  expect(elements.find(element => element.props["aria-label"] === "contentSync.serverUrl")!.props.disabled).toBe(false);
  expect(elements.find(element => element.props["aria-label"] === "contentSync.deviceName")!.props.disabled).toBe(false);
  elements.find(element => element.props.label === "contentSync.browse")!.props.onClick!();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/browse", search: { q: "", tab: "server" } });
});

it("keeps spaces while typing a device name and saves the trimmed name on blur", () => {
  mocks.state.deviceName = "";
  const deviceNameField = () => {
    mocks.stateIndex = 0;
    return controls(ContentServerSettings()).find(element => element.props["aria-label"] === "contentSync.deviceName")!;
  };
  const typeValue = (value: string) => {
    const onChange = deviceNameField().props.onChange as unknown as (event: { currentTarget: { value: string } }) => void;
    onChange({ currentTarget: { value } });
  };
  typeValue("");
  expect(deviceNameField().props.value).toBe("");
  for (const value of ["M", "My", "My ", "My P", "My Ph", "My Pho", "My Phon", "My Phone", "My Phone "]) {
    typeValue(value);
    expect(deviceNameField().props.value).toBe(value);
  }
  expect(mocks.state.setDeviceName).not.toHaveBeenCalled();
  deviceNameField().props.onBlur!();
  expect(mocks.state.setDeviceName).toHaveBeenCalledWith("My Phone");
});

function syncErrorProp(): unknown {
  const row = controls(ContentServerSettings()).find(element => (element.props as { error?: unknown }).error);
  return (row?.props as { error?: unknown } | undefined)?.error;
}

it("summarizes a raw sync failure in plain language and keeps the raw detail behind Details", () => {
  const raw = "Work / Chapter 307: content sync: upload stopped after sending 1 of 2 bytes in 120 s (attempt 2 of 2): request or response body error for url (https://server/api/v1/chapter-files)";
  mocks.state.error = raw;
  const line = syncErrorProp() as ReactElement<{ error: string }>;
  expect(line.props.error).toBe(raw);
  const rendered = (line.type as (props: { error: string }) => ReactElement<ControlProps>)(line.props);
  const [summary] = rendered.props.children as unknown[];
  expect(summary).toBe("contentSync.error.network");
  const elements = controls(rendered);
  expect(elements.some(element => element.type === "button" && element.props.children === "common.details")).toBe(true);
  expect(elements.some(element => element.props.children === raw)).toBe(true);
});

it("uses the general sync summary for server rejections and keeps the blocked message as is", () => {
  mocks.state.error = "Work / Chapter: content sync: server returned 400: Chapter files are incomplete";
  const line = syncErrorProp() as ReactElement<{ error: string }>;
  const rendered = (line.type as (props: { error: string }) => ReactElement<ControlProps>)(line.props);
  expect((rendered.props.children as unknown[])[0]).toBe("contentSync.error.generic");
  mocks.stateIndex = 0;
  mocks.state.error = null;
  mocks.state.blocked = true;
  expect(syncErrorProp()).toBe("contentSync.blocked");
});

it("explains that migration conflicts retain the original server copy", () => {
  mocks.state.error = "Server migration is pending for 1 merged work(s). The original server copies were retained. Conflict (409).";
  const line = syncErrorProp() as ReactElement<{ error: string }>;
  const rendered = (line.type as (props: { error: string }) => ReactElement<ControlProps>)(line.props);
  expect((rendered.props.children as unknown[])[0]).toBe("contentSync.error.migrationPending");
  expect(controls(rendered).some(element => element.props.children === mocks.state.error)).toBe(true);
});

import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  save: vi.fn(), navigate: vi.fn(), sync: vi.fn(), invalidate: vi.fn(),
  stateIndex: 0,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [mocks.stateIndex++ === 0 ? "http://new-server" : initial, vi.fn()],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../store/content-sync", () => ({ useContentSyncStore: (select: (state: Record<string, unknown>) => unknown) => select(mocks.state) }));
vi.mock("../lib/content-sync/sync", () => ({ syncContentServer: mocks.sync }));

import { ContentServerSettings } from "./ContentServerSettings";

interface ControlProps { children?: ReactNode; onClick?: () => void; disabled?: boolean; "aria-label"?: string }
function controls(node: ReactNode): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ControlProps>;
  return [element, ...controls(element.props.children)];
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.stateIndex = 0;
  mocks.state = { serverUrl: "http://server", deviceName: "Phone", syncMode: "manual", syncIntervalMinutes: 15,
    status: "syncing", error: null, blocked: false, setServerUrl: mocks.save,
    setDeviceName: vi.fn(), setSyncMode: vi.fn(), setSyncIntervalMinutes: vi.fn() };
});

it("saves a connection without refreshing unrelated plugin and library queries", async () => {
  const elements = controls(ContentServerSettings());
  elements.find(element => element.props.children === "common.save")!.props.onClick!();
  await Promise.resolve();
  expect(mocks.save).toHaveBeenCalledWith("http://new-server");
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

it("keeps connection editing and server browsing available during background synchronization", () => {
  const elements = controls(ContentServerSettings());
  expect(elements.find(element => element.props["aria-label"] === "contentSync.serverUrl")!.props.disabled).toBe(false);
  expect(elements.find(element => element.props["aria-label"] === "contentSync.deviceName")!.props.disabled).toBe(false);
  elements.find(element => element.props.children === "contentSync.browse")!.props.onClick!();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/browse", search: { q: "", tab: "server" } });
});

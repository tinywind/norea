import type { ReactElement, ReactNode } from "react";
import type { QueryClient, QueryObserver, UseQueryOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginVpnFinderServer } from "../lib/plugin-vpn";

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  stateIndex: 0,
  client: null as QueryClient | null,
  observer: null as QueryObserver<PluginVpnFinderServer[]> | null,
  unsubscribe: null as (() => void) | null,
  load: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.state)) mocks.state[index] = initial;
    return [mocks.state[index], (value: unknown) => { mocks.state[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.state)) mocks.state[index] = { current: initial };
    return mocks.state[index];
  },
  useMemo: (compute: () => unknown) => compute(),
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("@tanstack/react-query", async original => {
  const actual = await original<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => mocks.client!,
    useQuery: (options: UseQueryOptions<PluginVpnFinderServer[]>) => {
      if (!mocks.observer) {
        mocks.observer = new actual.QueryObserver(mocks.client!, options);
        mocks.unsubscribe = mocks.observer.subscribe(() => undefined);
      } else {
        mocks.observer.setOptions(options);
      }
      return mocks.observer.getCurrentResult();
    },
  };
});
vi.mock("../lib/plugin-vpn", () => ({ loadPluginVpnFinderServers: mocks.load }));
vi.mock("../lib/network", () => ({
  useNetworkStore: (select: (state: { connectivity: string }) => unknown) => select({ connectivity: "online" }),
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("../store/plugin-vpn-finder", async original => {
  const actual = await original<typeof import("../store/plugin-vpn-finder")>();
  const store = actual.usePluginVpnFinderStore;
  return {
    ...actual,
    usePluginVpnFinderStore: Object.assign(
      <T,>(select: (state: ReturnType<typeof store.getState>) => T) => select(store.getState()),
      store,
    ),
  };
});

import { QueryClient as ActualQueryClient } from "@tanstack/react-query";
import { Loader, Select, Switch, Table, TextInput } from "@mantine/core";
import {
  DEFAULT_PLUGIN_VPN_FINDER_FILTERS,
  usePluginVpnFinderStore,
} from "../store/plugin-vpn-finder";
import { ResponsiveSheet } from "./ui/ResponsiveSheet";
import { PluginVpnFinder } from "./PluginVpnFinder";
import { IconButton } from "./IconButton";

const server: PluginVpnFinderServer = {
  activeSessions: 2, candidateId: "one", countryCode: "JP", countryName: "Japan",
  hostName: "public-one", ip: "203.0.113.1", logType: "2weeks", pingMs: 20,
  protocol: "udp", score: 10, speedBps: 10_000_000, totalUsers: 20, uptimeMs: 1000,
};
interface ControlProps {
  children?: ReactNode;
  checked?: boolean;
  label?: string;
  onClose?: () => void;
  onClick?: () => void;
  onChange?: (event: { currentTarget: { checked: boolean; value: string } }) => void;
  value?: unknown;
}
function controls(node: ReactNode): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ControlProps>;
  return [element, ...controls(element.props.children)];
}
function render(
  opened = true,
  verdicts: ReadonlyMap<string, "works" | "fails"> = new Map(),
  overrides: Partial<Parameters<typeof PluginVpnFinder>[0]> = {},
) {
  mocks.stateIndex = 0;
  return controls(PluginVpnFinder({
    connectionError: null, connectionPhase: "disabled", connectionTarget: null,
    disabled: false, disabledReason: null, onApplyAndConnect: vi.fn(),
    onCancelConnection: vi.fn(), onClose: mocks.onClose, onVerdictChange: vi.fn(),
    opened, pendingCandidateId: null, verdictControlsDisabled: false,
    verdictDisabledReason: null, verdictSavingIps: new Set(), verdicts,
    ...overrides,
  }));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = [];
  usePluginVpnFinderStore.setState({ filters: DEFAULT_PLUGIN_VPN_FINDER_FILTERS });
  mocks.client = new ActualQueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.load.mockResolvedValue([server]);
});
afterEach(() => {
  mocks.unsubscribe?.();
  mocks.observer?.destroy();
  mocks.observer = null;
  mocks.unsubscribe = null;
  mocks.client?.clear();
});

it("retains the fetched catalog across modal closes and settings remounts until Refresh", async () => {
  render();
  await vi.waitFor(() => expect(mocks.observer?.getCurrentResult().isSuccess).toBe(true));
  expect(mocks.load).toHaveBeenCalledWith(false, expect.any(AbortSignal));
  render().find(element => element.type === ResponsiveSheet)!.props.onClose!();
  render(false);
  render(true);
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(mocks.observer?.getCurrentResult().data).toEqual([server]);

  mocks.unsubscribe?.();
  mocks.observer?.destroy();
  mocks.observer = null;
  mocks.state = [];
  render();
  expect(mocks.load).toHaveBeenCalledOnce();
  const refresh = render().find(element => element.type === IconButton &&
    element.props.label === "settings.data.pluginVpn.finder.refresh")!;
  refresh.props.onClick!();
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
  expect(mocks.load).toHaveBeenLastCalledWith(true, expect.any(AbortSignal));
});

it("preserves the last fetched catalog when an explicit refresh fails", async () => {
  render();
  await vi.waitFor(() => expect(mocks.observer?.getCurrentResult().isSuccess).toBe(true));
  mocks.load.mockRejectedValueOnce(new Error("server unavailable"));
  render().find(element => element.type === IconButton &&
    element.props.label === "settings.data.pluginVpn.finder.refresh")!.props.onClick!();
  await vi.waitFor(() => expect(mocks.observer?.getCurrentResult().isError).toBe(true));
  render().find(element => element.type === ResponsiveSheet)!.props.onClose!();
  render(false);
  render(true);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(mocks.observer?.getCurrentResult().data).toEqual([server]);
});

it("starts with failed verdicts hidden and reveals them when the user disables the filter", async () => {
  const verdicts = new Map([[server.ip, "fails" as const]]);
  render(true, verdicts);
  await vi.waitFor(() => expect(mocks.observer?.getCurrentResult().isSuccess).toBe(true));
  const hidden = render(true, verdicts);
  expect(hidden.some(element => element.type === Table.Tbody)).toBe(false);
  const filter = hidden.find(element => element.type === Switch)!;
  expect(filter.props.checked).toBe(true);
  filter.props.onChange!({ currentTarget: { checked: false, value: "" } });
  expect(render(true, verdicts).some(element => element.type === Table.Tbody)).toBe(true);
  expect(mocks.load).toHaveBeenCalledOnce();
});

it("connects from an icon button on each server and turns the pending one into a cancel", async () => {
  render();
  await vi.waitFor(() => expect(mocks.observer?.getCurrentResult().isSuccess).toBe(true));
  const onApplyAndConnect = vi.fn().mockResolvedValue(undefined);
  const iconLabels = (view: ReturnType<typeof render>) =>
    view.filter(element => element.type === IconButton).map(element => element.props.label);
  const idle = render(true, new Map(), { onApplyAndConnect });
  expect(iconLabels(idle).filter(label => label === "settings.data.pluginVpn.connection.connect")).toHaveLength(2);
  idle.find(element => element.type === IconButton &&
    element.props.label === "settings.data.pluginVpn.connection.connect")!.props.onClick!();
  await vi.waitFor(() => expect(onApplyAndConnect).toHaveBeenCalledWith("one"));

  const onCancelConnection = vi.fn().mockResolvedValue(undefined);
  const pending = render(true, new Map(), { connectionPhase: "connecting", onCancelConnection, pendingCandidateId: "one" });
  expect(iconLabels(pending)).not.toContain("settings.data.pluginVpn.connection.connect");
  const cancel = pending.find(element => element.type === IconButton &&
    element.props.label === "settings.data.pluginVpn.connection.cancel" &&
    (element.props.children as ReactElement).type === Loader);
  expect(cancel).toBeDefined();
  cancel!.props.onClick!();
  await vi.waitFor(() => expect(onCancelConnection).toHaveBeenCalledOnce());
});

it("closes once a connection started here is up, and stays open on an existing connection", async () => {
  render();
  await vi.waitFor(() => expect(mocks.observer?.getCurrentResult().isSuccess).toBe(true));
  const onApplyAndConnect = vi.fn().mockResolvedValue(undefined);
  const connected = render(true, new Map(), { connectionPhase: "connected", onApplyAndConnect });
  expect(mocks.onClose).not.toHaveBeenCalled();
  connected.find(element => element.type === IconButton &&
    element.props.label === "settings.data.pluginVpn.connection.connect")!.props.onClick!();
  await vi.waitFor(() => expect(onApplyAndConnect).toHaveBeenCalledWith("one"));
  render(true, new Map(), { connectionPhase: "connected", onApplyAndConnect });
  expect(mocks.onClose).not.toHaveBeenCalled();
  render(true, new Map(), { connectionPhase: "connecting", onApplyAndConnect, pendingCandidateId: "one" });
  expect(mocks.onClose).not.toHaveBeenCalled();
  render(true, new Map(), { connectionPhase: "connected", onApplyAndConnect });
  expect(mocks.onClose).toHaveBeenCalledOnce();
});

it("keeps search conditions after the finder closes and the settings page remounts", async () => {
  const korea: PluginVpnFinderServer = { ...server, candidateId: "two", countryCode: "KR", countryName: "Korea", ip: "203.0.113.2" };
  mocks.load.mockResolvedValue([server, korea]);
  render();
  await vi.waitFor(() => expect(mocks.observer?.getCurrentResult().isSuccess).toBe(true));
  const view = render();
  view.find(element => element.type === TextInput)!.props.onChange!({ currentTarget: { checked: false, value: "ko" } });
  const selects = view.filter(element => element.type === Select) as unknown as ReactElement<{ onChange: (value: string | null) => void }>[];
  selects[0]!.props.onChange("KR");
  selects[1]!.props.onChange("udp");
  selects[2]!.props.onChange("ping");
  view.find(element => element.type === Switch)!.props.onChange!({ currentTarget: { checked: false, value: "" } });
  render().find(element => element.type === ResponsiveSheet)!.props.onClose!();
  render(false);

  mocks.state = [];
  const reopened = render();
  expect(reopened.find(element => element.type === TextInput)!.props.value).toBe("ko");
  expect(reopened.filter(element => element.type === Select).map(element => element.props.value))
    .toEqual(["KR", "udp", "ping"]);
  expect(reopened.find(element => element.type === Switch)!.props.checked).toBe(false);
  expect(reopened.filter(element => element.type === Table.Tr)).toHaveLength(2);
});

it("lists every country when a remembered country is missing from the current servers", async () => {
  usePluginVpnFinderStore.getState().setFilters({ countryCode: "DE" });
  render();
  await vi.waitFor(() => expect(mocks.observer?.getCurrentResult().isSuccess).toBe(true));
  const view = render();
  expect(view.find(element => element.type === Select)!.props.value).toBeNull();
  expect(view.filter(element => element.type === Table.Tr)).toHaveLength(2);
  expect(usePluginVpnFinderStore.getState().filters.countryCode).toBe("DE");
});

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  states: [] as unknown[],
  index: 0,
  android: true,
  tauri: true,
  ensureProxy: vi.fn<() => Promise<void>>(),
  storageRoot: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => {
    mocks.effects.push(effect);
  },
  useState: (initial: unknown) => {
    const index = mocks.index++;
    if (!(index in mocks.states)) {
      mocks.states[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      mocks.states[index],
      (next: unknown) => {
        mocks.states[index] =
          typeof next === "function" ? next(mocks.states[index]) : next;
      },
    ];
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("../../store/appearance", () => ({
  useAppearanceStore: Object.assign(
    <T,>(select: (state: { appLocale: "en" }) => T) => select({ appLocale: "en" }),
    { getState: () => ({ appLocale: "en" }) },
  ),
}));
vi.mock("../../lib/tauri-runtime", () => ({
  isAndroidRuntime: () => mocks.android,
  isTauriRuntime: () => mocks.tauri,
}));
vi.mock("../../lib/plugin-vpn", () => ({
  ensureAndroidPluginVpnProxy: mocks.ensureProxy,
  PLUGIN_VPN_QUERY_KEY: ["plugin-vpn"],
  shouldShowPluginVpnReconnectedToast: () => false,
  startPluginVpnStatusListener: () => Promise.resolve(() => undefined),
}));
vi.mock("../../lib/plugin-vpn-lifecycle", () => ({
  startPluginVpnLifecycle: () => () => undefined,
}));
vi.mock("../../lib/plugin-vpn-keep-alive", () => ({
  startAndroidPluginVpnKeepAlive: () => () => undefined,
}));
vi.mock("../../lib/runtime/error-toast", () => ({ showErrorToast: vi.fn() }));
vi.mock("../../lib/chapter-media-storage", () => ({
  getChapterMediaStorageRoot: mocks.storageRoot,
  selectChapterMediaStorageRoot: vi.fn(),
}));
vi.mock("../../lib/plugins/manager", () => ({
  pluginManager: { loadInstalledFromDb: () => Promise.resolve() },
}));
vi.mock("./StorageRecovery", () => ({ StorageRecoveryNotifications: () => null }));

import { ChapterMediaStorageGate } from "./ChapterMediaStorageGate";
import { PluginVpnProxyGate } from "./PluginVpnProxyGate";
import { StartupSplash } from "./StartupSplash";

type Gate = (props: { children: ReactNode }) => ReactNode;
type Props = { children?: ReactNode; onClick?: () => void };

const APP = <main data-app="ready" />;

function render(gate: Gate): ReactNode {
  mocks.index = 0;
  mocks.effects = [];
  return gate({ children: APP });
}

function runEffects(): void {
  for (const effect of mocks.effects.splice(0)) effect();
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Props>(node) ? text(node.props.children) : "";
}

function isSplash(node: ReactNode): boolean {
  return isValidElement(node) && node.type === StartupSplash;
}

beforeEach(() => {
  mocks.states = [];
  mocks.android = true;
  mocks.tauri = true;
  mocks.ensureProxy.mockReset();
  mocks.storageRoot.mockReset();
});

describe("PluginVpnProxyGate", () => {
  it("shows the shared splash while the Android network setup runs", () => {
    mocks.ensureProxy.mockReturnValue(new Promise(() => undefined));

    expect(isSplash(render(PluginVpnProxyGate))).toBe(true);
  });

  it("keeps the error and Retry state, and returns to the splash on Retry", async () => {
    mocks.ensureProxy.mockRejectedValueOnce(new Error("bind failed"));
    render(PluginVpnProxyGate);
    runEffects();
    await vi.waitFor(() => expect(mocks.states[1]).toBe(false));

    const failed = render(PluginVpnProxyGate);
    expect(isSplash(failed)).toBe(false);
    expect(text(failed)).toContain("Network setup didn't finish");
    expect(text(failed)).toContain("Details: bind failed");
    const retry = elements(failed).find((element) => text(element) === "Try again");
    expect(retry?.props.onClick).toBeTypeOf("function");

    mocks.ensureProxy.mockReturnValue(new Promise(() => undefined));
    retry!.props.onClick!();
    render(PluginVpnProxyGate);
    runEffects();

    expect(isSplash(render(PluginVpnProxyGate))).toBe(true);
    expect(mocks.ensureProxy).toHaveBeenCalledTimes(2);
  });

  it("renders the app directly outside Android", () => {
    mocks.android = false;

    expect(render(PluginVpnProxyGate)).toBe(APP);
  });
});

describe("ChapterMediaStorageGate", () => {
  it("shows the same splash while it checks the storage folder", () => {
    mocks.storageRoot.mockReturnValue(new Promise(() => undefined));

    expect(isSplash(render(ChapterMediaStorageGate))).toBe(true);
  });

  it("asks Android users to choose a folder when none is set", async () => {
    mocks.storageRoot.mockResolvedValueOnce(null);
    render(ChapterMediaStorageGate);
    runEffects();
    await vi.waitFor(() => expect(mocks.states[0]).toBe(false));

    const setup = render(ChapterMediaStorageGate);
    expect(isSplash(setup)).toBe(false);
    expect(text(setup)).toContain("Choose where to save chapters");
    expect(text(setup)).toContain("Select external folder");
  });

  it("tells Android users to pick the Norea folder itself, not a folder inside it", async () => {
    mocks.storageRoot.mockResolvedValueOnce(null);
    render(ChapterMediaStorageGate);
    runEffects();
    await vi.waitFor(() => expect(mocks.states[0]).toBe(false));

    const copy = text(render(ChapterMediaStorageGate));
    expect(copy).toContain("choose that same Norea folder itself, not a folder inside it");
    expect(copy).toContain("Use this folder");
  });

  it("leaves the Android picker hint out on desktop", async () => {
    mocks.android = false;
    mocks.storageRoot.mockResolvedValueOnce(null);
    render(ChapterMediaStorageGate);
    runEffects();
    await vi.waitFor(() => expect(mocks.states[0]).toBe(false));

    expect(text(render(ChapterMediaStorageGate))).not.toContain("Use this folder");
  });
});

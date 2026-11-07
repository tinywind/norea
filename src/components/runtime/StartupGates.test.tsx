import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  effectIndex: 0,
  effectDependencies: [] as (readonly unknown[] | undefined)[],
  effectCleanups: [] as ((() => void) | undefined)[],
  states: [] as unknown[],
  index: 0,
  android: true,
  tauri: true,
  rotateFingerprint: false,
  fingerprintSupported: false,
  setPolicy: vi.fn<(patch: { rotateFingerprintOnVpnChange?: boolean }) => void>(),
  startLifecycle: vi.fn(),
  stopLifecycle: vi.fn(),
  startStatusListener: vi.fn<() => Promise<() => void>>(),
  unlistenStatus: vi.fn(),
  queryClient: { setQueryData: vi.fn(), invalidateQueries: vi.fn() },
  ensureProxy: vi.fn<() => Promise<void>>(),
  storageRoot: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const index = mocks.effectIndex++;
    const previous = mocks.effectDependencies[index];
    if (dependencies && previous && dependencies.length === previous.length &&
      dependencies.every((value, offset) => Object.is(value, previous[offset]))) return;
    mocks.effectDependencies[index] = dependencies;
    mocks.effects.push(() => {
      mocks.effectCleanups[index]?.();
      mocks.effectCleanups[index] = effect() ?? undefined;
    });
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
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks.queryClient }));
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
  startPluginVpnStatusListener: mocks.startStatusListener,
}));
vi.mock("../../lib/plugin-vpn-lifecycle", () => ({
  startPluginVpnLifecycle: mocks.startLifecycle,
}));
vi.mock("../../lib/runtime/error-toast", () => ({ showErrorToast: vi.fn() }));
vi.mock("../../lib/site-browser/session", () => ({ canRotateBrowserFingerprint: () => mocks.fingerprintSupported }));
vi.mock("../../store/download-recovery", () => ({
  useDownloadRecoveryStore: <T,>(select: (state: {
    rotateFingerprintOnVpnChange: boolean; setPolicy: typeof mocks.setPolicy;
  }) => T) => select({ rotateFingerprintOnVpnChange: mocks.rotateFingerprint, setPolicy: mocks.setPolicy }),
}));
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
  mocks.effectIndex = 0;
  mocks.effects = [];
  return gate({ children: APP });
}

function runEffects(): void {
  for (const effect of mocks.effects.splice(0)) effect();
}

function unmount(): void {
  for (const cleanup of mocks.effectCleanups.splice(0)) cleanup?.();
  mocks.effectDependencies = [];
  mocks.effects = [];
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
  mocks.effectDependencies = [];
  mocks.effectCleanups = [];
  mocks.android = true;
  mocks.tauri = true;
  mocks.rotateFingerprint = false;
  mocks.fingerprintSupported = false;
  mocks.setPolicy.mockReset().mockImplementation((patch) => {
    if (patch.rotateFingerprintOnVpnChange !== undefined) mocks.rotateFingerprint = patch.rotateFingerprintOnVpnChange;
  });
  mocks.stopLifecycle.mockReset();
  mocks.unlistenStatus.mockReset();
  mocks.startLifecycle.mockReset().mockReturnValue(mocks.stopLifecycle);
  mocks.startStatusListener.mockReset().mockResolvedValue(mocks.unlistenStatus);
  mocks.ensureProxy.mockReset();
  mocks.storageRoot.mockReset();
});

afterEach(unmount);

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

  it("renders the app and starts the existing lifecycle directly outside Android", () => {
    mocks.android = false;

    expect(render(PluginVpnProxyGate)).toBe(APP);
    runEffects();
    expect(mocks.ensureProxy).not.toHaveBeenCalled();
    expect(mocks.startLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.startStatusListener).toHaveBeenCalledTimes(1);
  });

  it("starts the VPN lifecycle only after initial Android configuration succeeds", async () => {
    let configured!: () => void;
    mocks.ensureProxy.mockReturnValue(new Promise<void>((resolve) => { configured = resolve; }));
    render(PluginVpnProxyGate); runEffects();
    expect(mocks.startLifecycle).not.toHaveBeenCalled();
    expect(mocks.startStatusListener).not.toHaveBeenCalled();

    configured();
    await vi.waitFor(() => expect(mocks.states[1]).toBe(false));
    expect(render(PluginVpnProxyGate)).toBe(APP);
    runEffects();
    expect(mocks.startLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.startStatusListener).toHaveBeenCalledTimes(1);

    render(PluginVpnProxyGate); runEffects();
    expect(mocks.startLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.ensureProxy).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    unmount();
    expect(mocks.stopLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.unlistenStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps recovery and status listeners stopped after initial configuration fails", async () => {
    mocks.ensureProxy.mockRejectedValue(new Error("Browser environment rotation is unavailable."));
    render(PluginVpnProxyGate); runEffects();
    await vi.waitFor(() => expect(mocks.states[1]).toBe(false));
    const failed = render(PluginVpnProxyGate); runEffects();
    expect(failed).not.toBe(APP);
    expect(text(failed)).toContain("Browser environment rotation is unavailable.");
    expect(mocks.startLifecycle).not.toHaveBeenCalled();
    expect(mocks.startStatusListener).not.toHaveBeenCalled();
    expect(mocks.setPolicy).not.toHaveBeenCalled();
  });

  it("turns off only the unsupported saved fingerprint setting after an explicit click and waits for reconfiguration", async () => {
    mocks.rotateFingerprint = true; mocks.fingerprintSupported = false;
    mocks.ensureProxy.mockRejectedValueOnce(new Error("Browser environment rotation is unavailable."));
    render(PluginVpnProxyGate); runEffects();
    await vi.waitFor(() => expect(mocks.states[1]).toBe(false));
    const failed = render(PluginVpnProxyGate);
    const recovery = elements(failed).find((element) =>
      element.props.onClick && text(element) === "Turn off fingerprint rotation and retry");
    expect(recovery).toBeDefined();
    expect(mocks.rotateFingerprint).toBe(true);
    expect(mocks.setPolicy).not.toHaveBeenCalled();
    expect(mocks.startLifecycle).not.toHaveBeenCalled();

    let configured!: () => void;
    mocks.ensureProxy.mockImplementationOnce(() => {
      expect(mocks.rotateFingerprint).toBe(false);
      return new Promise<void>((resolve) => { configured = resolve; });
    });
    recovery!.props.onClick!();
    expect(mocks.setPolicy).toHaveBeenCalledExactlyOnceWith({ rotateFingerprintOnVpnChange: false });
    render(PluginVpnProxyGate); runEffects();
    expect(isSplash(render(PluginVpnProxyGate))).toBe(true);
    expect(mocks.startLifecycle).not.toHaveBeenCalled();
    expect(mocks.startStatusListener).not.toHaveBeenCalled();

    configured();
    await vi.waitFor(() => expect(mocks.states[1]).toBe(false));
    expect(render(PluginVpnProxyGate)).toBe(APP);
    runEffects();
    expect(mocks.ensureProxy).toHaveBeenCalledTimes(2);
    expect(mocks.startLifecycle).toHaveBeenCalledTimes(1);
  });

  it("keeps the app behind the gate if reconfiguration fails after fingerprint rotation is turned off", async () => {
    mocks.rotateFingerprint = true; mocks.fingerprintSupported = false;
    mocks.ensureProxy.mockRejectedValueOnce(new Error("Browser environment rotation is unavailable."));
    render(PluginVpnProxyGate); runEffects();
    await vi.waitFor(() => expect(mocks.states[1]).toBe(false));
    const recovery = elements(render(PluginVpnProxyGate)).find((element) =>
      element.props.onClick && text(element) === "Turn off fingerprint rotation and retry")!;
    mocks.ensureProxy.mockRejectedValueOnce(new Error("Proxy is still unavailable."));
    recovery.props.onClick!();
    render(PluginVpnProxyGate); runEffects();
    await vi.waitFor(() => expect(mocks.states[1]).toBe(false));
    const failed = render(PluginVpnProxyGate); runEffects();
    expect(failed).not.toBe(APP);
    expect(text(failed)).toContain("Proxy is still unavailable.");
    expect(text(failed)).not.toContain("Turn off fingerprint rotation and retry");
    expect(text(failed)).toContain("Try again");
    expect(mocks.setPolicy).toHaveBeenCalledExactlyOnceWith({ rotateFingerprintOnVpnChange: false });
    expect(mocks.startLifecycle).not.toHaveBeenCalled();
    expect(mocks.startStatusListener).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false, supported: false },
    { enabled: true, supported: true },
  ])("does not offer fingerprint reset for enabled=$enabled and supported=$supported", async ({ enabled, supported }) => {
    mocks.rotateFingerprint = enabled; mocks.fingerprintSupported = supported;
    mocks.ensureProxy.mockRejectedValueOnce(new Error("Unrelated proxy failure."));
    render(PluginVpnProxyGate); runEffects();
    await vi.waitFor(() => expect(mocks.states[1]).toBe(false));
    expect(text(render(PluginVpnProxyGate))).not.toContain("Turn off fingerprint rotation and retry");
    expect(mocks.setPolicy).not.toHaveBeenCalled();
  });

  it("does not start the native lifecycle in an ordinary browser", () => {
    mocks.android = false; mocks.tauri = false; mocks.rotateFingerprint = true;
    expect(render(PluginVpnProxyGate)).toBe(APP); runEffects();
    expect(mocks.ensureProxy).not.toHaveBeenCalled();
    expect(mocks.startLifecycle).not.toHaveBeenCalled();
    expect(mocks.startStatusListener).not.toHaveBeenCalled();
    expect(mocks.setPolicy).not.toHaveBeenCalled();
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

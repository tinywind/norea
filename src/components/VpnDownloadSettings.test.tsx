import { NumberInput } from "@mantine/core";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadLaunchOptions } from "../lib/tasks/vpn-download-types";

vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const store = vi.hoisted(() => ({ resumeAfterRestart: true, setResumeAfterRestart: vi.fn(), useTestedServers: true, setUseTestedServers: vi.fn() }));
vi.mock("../store/vpn-download", () => ({ useVpnDownloadStore: (select: (value: unknown) => unknown) => select(store) }));
import { VpnDownloadSettings } from "./VpnDownloadSettings";

interface Props {
  children?: ReactNode;
  "aria-label"?: string;
  disabled?: boolean;
  checked?: boolean;
  onChange?: (event: { currentTarget: { checked: boolean } }) => void;
}
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
const capabilities = { supported: true, parallelSupported: true, maxWorkers: 10 };
const value: VpnDownloadLaunchOptions = { workerCount: 10, captchaPolicy: "pause", cloudflarePolicy: "pause" };
const change = vi.fn();
const render = (caps = capabilities, disabled = false) => controls(VpnDownloadSettings({ capabilities: caps, value, onChange: change, disabled }));
const get = (view: ReactElement<Props>[], key: string) => view.find(element => element.props["aria-label"] === key)!;
beforeEach(() => { vi.clearAllMocks(); });

it("explains sequential downloads without offering a parallel worker control", () => {
  const view = render();
  expect(view.some(element => element.type === NumberInput)).toBe(false);
  expect(view.some(element => element.props.children === "vpnDownload.workerCountSingle")).toBe(true);
  expect(view.some(element => element.props.children === "vpnDownload.errorStopHint")).toBe(true);
  expect(get(view, "vpnDownload.captchaPolicy")).toBeUndefined();
  expect(get(view, "vpnDownload.cloudflarePolicy")).toBeUndefined();
  expect(get(view, "vpnDownload.mode")).toBeUndefined();
  expect(change).not.toHaveBeenCalled();
});

it.each([
  [{ supported: false, parallelSupported: false, maxWorkers: 0 }, false],
  [capabilities, true],
])("guards preference callbacks while the device or form is unavailable", (caps, disabled) => {
  const view = render(caps, disabled);
  for (const key of ["vpnDownload.resumeAfterRestart", "vpnDownload.useTestedServers"]) {
    const toggle = get(view, key);
    expect(toggle.props.disabled).toBe(true);
    toggle.props.onChange!({ currentTarget: { checked: false } });
  }
  expect(store.setResumeAfterRestart).not.toHaveBeenCalled();
  expect(store.setUseTestedServers).not.toHaveBeenCalled();
});

it("stores the restart resume choice directly", () => {
  const toggle = get(render(), "vpnDownload.resumeAfterRestart");
  expect(toggle.props.checked).toBe(true);
  toggle.props.onChange!({ currentTarget: { checked: false } });
  expect(store.setResumeAfterRestart).toHaveBeenCalledWith(false);
  expect(change).not.toHaveBeenCalled();
});

it("uses tested servers by default and stores Approved only directly", () => {
  const toggle = get(render(), "vpnDownload.useTestedServers");
  expect(toggle.props.checked).toBe(true);
  toggle.props.onChange!({ currentTarget: { checked: false } });
  expect(store.setUseTestedServers).toHaveBeenCalledWith(false);
  expect(change).not.toHaveBeenCalled();
});

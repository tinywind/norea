import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadLaunchOptions } from "../lib/tasks/vpn-download-types";

vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const store = vi.hoisted(() => ({ resumeAfterRestart: true, setResumeAfterRestart: vi.fn(), useTestedServers: true, setUseTestedServers: vi.fn() }));
vi.mock("../store/vpn-download", () => ({ useVpnDownloadStore: (select: (value: unknown) => unknown) => select({
  mode: "parallel", workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile",
  setMode: vi.fn(), setWorkerCount: vi.fn(), setCaptchaPolicy: vi.fn(), setCloudflarePolicy: vi.fn(), ...store,
}) }));
import { VpnDownloadSettings } from "./VpnDownloadSettings";

interface Props {
  children?: ReactNode;
  "aria-label"?: string;
  value?: unknown;
  disabled?: boolean;
  min?: number;
  max?: number;
  checked?: boolean;
  onChange?: (value: string | number | null) => void;
}
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
const capabilities = { supported: true, parallelSupported: true, maxWorkers: 10 };
const value: VpnDownloadLaunchOptions = { workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile" };
const change = vi.fn();
const render = (caps = capabilities, disabled = false) => controls(VpnDownloadSettings({ capabilities: caps, value, onChange: change, disabled }));
const get = (view: ReactElement<Props>[], key: string) => view.find(element => element.props["aria-label"] === key)!;
beforeEach(() => { vi.clearAllMocks(); });

it("shows the fixed error-stop rule without offering automatic profile rotation", () => {
  const view = render();
  expect(get(view, "vpnDownload.captchaPolicy")).toBeUndefined();
  expect(get(view, "vpnDownload.cloudflarePolicy")).toBeUndefined();
  expect(view.some(element => element.props.children === "vpnDownload.errorStopHint")).toBe(true);
  expect(get(view, "vpnDownload.mode")).toBeUndefined();
});

it.each([1, 3, 10])("accepts a global worker count of %s without profile or range inputs", count => {
  const workers = get(render(), "vpnDownload.workerCount");
  expect(workers.props.min).toBe(1);
  expect(workers.props.max).toBe(10);
  workers.props.onChange!(count);
  expect(change).toHaveBeenCalledWith({ ...value, workerCount: count });
});

it.each([0, 11, 1.5, "", null])("does not submit an invalid worker count %s", count => {
  get(render(), "vpnDownload.workerCount").props.onChange!(count);
  expect(change).not.toHaveBeenCalled();
});

it("limits a single-worker device and guards callbacks while submission is pending", () => {
  expect(get(render({ supported: true, parallelSupported: false, maxWorkers: 1 }), "vpnDownload.workerCount").props.max).toBe(1);
  const view = render(capabilities, true);
  for (const key of ["vpnDownload.workerCount", "vpnDownload.resumeAfterRestart", "vpnDownload.useTestedServers"]) {
    expect(get(view, key).props.disabled).toBe(true);
  }
  get(view, "vpnDownload.workerCount").props.onChange!(3);
  expect(change).not.toHaveBeenCalled();
});

it("stores the restart resume choice directly instead of in the unsubmitted launch options", () => {
  const toggle = get(render(), "vpnDownload.resumeAfterRestart");
  expect(toggle.props.checked).toBe(true);
  const onToggle = toggle.props.onChange as unknown as (event: { currentTarget: { checked: boolean } }) => void;
  onToggle({ currentTarget: { checked: false } });
  expect(store.setResumeAfterRestart).toHaveBeenCalledWith(false);
  expect(change).not.toHaveBeenCalled();
});

it("uses tested servers by default and stores Approved only directly", () => {
  const toggle = get(render(), "vpnDownload.useTestedServers");
  expect(toggle.props.checked).toBe(true);
  const onToggle = toggle.props.onChange as unknown as (event: { currentTarget: { checked: boolean } }) => void;
  onToggle({ currentTarget: { checked: false } });
  expect(store.setUseTestedServers).toHaveBeenCalledWith(false);
  expect(change).not.toHaveBeenCalled();
});

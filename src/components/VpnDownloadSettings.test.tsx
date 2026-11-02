import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "off", workerCount: 2, captchaPolicy: "pause", cloudflarePolicy: "pause",
  setMode: vi.fn(), setWorkerCount: vi.fn(), setCaptchaPolicy: vi.fn(), setCloudflarePolicy: vi.fn(),
}));
vi.mock("../store/vpn-download", () => ({ useVpnDownloadStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { VpnDownloadSettings } from "./VpnDownloadSettings";

interface Props { children?: ReactNode; "aria-label"?: string; value?: unknown; disabled?: boolean; max?: number; data?: { value: string; disabled?: boolean }[]; onChange?: (value: string | number) => void }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
const capabilities = { supported: true, parallelSupported: true, maxWorkers: 2 };
const render = (caps = capabilities, hasPlans = false) => controls(VpnDownloadSettings({ capabilities: caps, hasPlans }));
beforeEach(() => { vi.clearAllMocks(); state.mode = "off"; state.workerCount = 2; state.captchaPolicy = "pause"; state.cloudflarePolicy = "pause"; });

it("keeps separate policy defaults and routes explicit selections to the settings store", () => {
  state.mode = "single";
  const view = render();
  const get = (key: string) => view.find(element => element.props["aria-label"] === key)!;
  expect(get("vpnDownload.captchaPolicy").props.value).toBe("pause");
  expect(get("vpnDownload.cloudflarePolicy").props.value).toBe("pause");
  get("vpnDownload.mode").props.onChange!("off");
  get("vpnDownload.captchaPolicy").props.onChange!("nextProfile");
  get("vpnDownload.cloudflarePolicy").props.onChange!("pause");
  expect(state.setMode).toHaveBeenCalledWith("off");
  expect(state.setCaptchaPolicy).toHaveBeenCalledWith("nextProfile");
  expect(state.setCloudflarePolicy).toHaveBeenCalledWith("pause");
});

it("only shows the bounded worker count in parallel mode and explains that active plans are frozen", () => {
  expect(render().some(element => element.props["aria-label"] === "vpnDownload.workerCount")).toBe(false);
  state.mode = "parallel";
  const view = render(capabilities, true);
  const workers = view.find(element => element.props["aria-label"] === "vpnDownload.workerCount")!;
  expect(workers.props.max).toBe(2);
  workers.props.onChange!(1);
  expect(state.setWorkerCount).toHaveBeenCalledWith(1);
  expect(view.some(element => element.props.children === "vpnDownload.newBatchesOnly")).toBe(true);
});

it("leaves Off available while disabling unsupported native choices and guarding their callbacks", () => {
  const view = render({ supported: false, parallelSupported: false, maxWorkers: 0 });
  const mode = view.find(element => element.props["aria-label"] === "vpnDownload.mode")!;
  expect(mode.props.data).toEqual([
    { value: "off", label: "vpnDownload.mode.off" },
    { value: "single", label: "vpnDownload.mode.single", disabled: true },
    { value: "parallel", label: "vpnDownload.mode.parallel", disabled: true },
  ]);
  mode.props.onChange!("parallel");
  expect(state.setMode).not.toHaveBeenCalled();
  mode.props.onChange!("off");
  expect(state.setMode).toHaveBeenCalledWith("off");
  expect(view.some(element => element.props.children === "vpnDownload.unsupported")).toBe(true);
});

it("disables only parallel mode when single-worker recovery is supported", () => {
  const view = render({ supported: true, parallelSupported: false, maxWorkers: 1 });
  const mode = view.find(element => element.props["aria-label"] === "vpnDownload.mode")!;
  expect(mode.props.data?.find(option => option.value === "single")?.disabled).toBe(false);
  expect(mode.props.data?.find(option => option.value === "parallel")?.disabled).toBe(true);
});

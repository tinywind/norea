import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DownloadRecoveryPolicy } from "../../store/download-recovery";

const mocks = vi.hoisted(() => ({
  policy: {} as DownloadRecoveryPolicy, setPolicy: vi.fn(),
  resetSupported: true, fingerprintSupported: true,
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../store/download-recovery", () => ({
  useDownloadRecoveryStore: () => ({ ...mocks.policy, setPolicy: mocks.setPolicy }),
}));
vi.mock("../../lib/site-browser/session", () => ({
  canResetSourceSiteData: () => mocks.resetSupported,
  canRotateBrowserFingerprint: () => mocks.fingerprintSupported,
}));
import { DownloadRecoverySettings } from "./DownloadRecoverySettings";

interface Props {
  children?: ReactNode;
  "aria-label"?: string;
  data?: { value: string; disabled?: boolean }[];
  disabled?: boolean;
  checked?: boolean;
  value?: string | number;
  min?: number;
  max?: number;
  status?: string | null;
  onChange?: (value: string | number | null) => void;
}
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
const render = (isBusy = false) => controls(DownloadRecoverySettings({ isBusy }));
const get = (view: ReactElement<Props>[], row: string) =>
  view.find(element => element.props["aria-label"] === `settings.downloads.recovery.${row}.label`)!;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resetSupported = true;
  mocks.fingerprintSupported = true;
  mocks.policy = {
    forbiddenAction: "pause", transientAction: "pause", rateLimitAction: "pause", notFoundAction: "skip",
    maxRetries: 2, retryDelaySeconds: 30, maxProfileChanges: 1, rotateFingerprintOnVpnChange: false,
  };
});

it("offers only the implemented actions for each error and shows safe defaults", () => {
  const view = render();
  expect(get(view, "forbidden").props.data?.map(option => option.value)).toEqual(["pause", "retry", "resetSite"]);
  expect(get(view, "transient").props.data?.map(option => option.value)).toEqual(["pause", "retry", "nextProfile"]);
  expect(get(view, "rateLimit").props.data?.map(option => option.value)).toEqual(["pause", "retry"]);
  expect(get(view, "notFound").props.data?.map(option => option.value)).toEqual(["skip", "pause"]);
  for (const row of ["forbidden", "transient", "rateLimit"]) expect(get(view, row).props.value).toBe("pause");
  expect(get(view, "notFound").props.value).toBe("skip");
  expect(get(view, "fingerprint").props.checked).toBe(false);
  expect(view.some(element => element.props.children === "settings.downloads.recovery.resetHint")).toBe(true);
});

it("saves an action without accepting actions from the wrong error class", () => {
  const view = render();
  get(view, "forbidden").props.onChange!("resetSite");
  get(view, "transient").props.onChange!("nextProfile");
  get(view, "rateLimit").props.onChange!("nextProfile");
  get(view, "notFound").props.onChange!("retry");
  expect(mocks.setPolicy.mock.calls).toEqual([
    [{ forbiddenAction: "resetSite" }], [{ transientAction: "nextProfile" }],
  ]);
});

it("disables unsupported site reset and guards a stale selection callback", () => {
  mocks.resetSupported = false;
  const view = render();
  const forbidden = get(view, "forbidden");
  expect(forbidden.props.data?.find(option => option.value === "resetSite")?.disabled).toBe(true);
  expect(view.some(element => element.props.status === "settings.downloads.recovery.resetUnsupported")).toBe(true);
  forbidden.props.onChange!("resetSite");
  expect(mocks.setPolicy).not.toHaveBeenCalled();
  forbidden.props.onChange!("retry");
  expect(mocks.setPolicy).toHaveBeenCalledWith({ forbiddenAction: "retry" });
});

it("lets fingerprint rotation change only when supported and explains the shared connection scope", () => {
  let view = render();
  expect(view.some(element => element.props.children === "settings.downloads.recovery.fingerprint.hint")).toBe(true);
  const change = get(view, "fingerprint").props.onChange as unknown as (event: { currentTarget: { checked: boolean } }) => void;
  change({ currentTarget: { checked: true } });
  expect(mocks.setPolicy).toHaveBeenLastCalledWith({ rotateFingerprintOnVpnChange: true });
  mocks.setPolicy.mockClear();
  mocks.fingerprintSupported = false;
  view = render();
  expect(get(view, "fingerprint").props.disabled).toBe(true);
  expect(view.some(element => element.props.status === "settings.downloads.recovery.fingerprintUnsupported")).toBe(true);
  const unsupported = get(view, "fingerprint").props.onChange as unknown as typeof change;
  unsupported({ currentTarget: { checked: true } });
  expect(mocks.setPolicy).not.toHaveBeenCalled();
});

it("presents the same attempt and delay bounds as the stored policy", () => {
  const view = render();
  expect(get(view, "maxRetries").props).toMatchObject({ min: 0, max: 5, value: 2 });
  expect(get(view, "retryDelay").props).toMatchObject({ min: 5, max: 3_600, value: 30 });
  expect(get(view, "maxProfileChanges").props).toMatchObject({ min: 0, max: 3, value: 1 });
  get(view, "retryDelay").props.onChange!(60);
  expect(mocks.setPolicy).toHaveBeenCalledWith({ retryDelaySeconds: 60 });
});

it("does not modify policy while settings are busy", () => {
  const view = render(true);
  const labelled = view.filter(element => element.props["aria-label"]);
  expect(labelled).toHaveLength(8);
  expect(labelled.every(element => element.props.disabled)).toBe(true);
  get(view, "forbidden").props.onChange!("retry");
  get(view, "maxRetries").props.onChange!(5);
  expect(mocks.setPolicy).not.toHaveBeenCalled();
});

it("lets a saved fingerprint option be turned off after the device loses support", () => {
  mocks.policy.rotateFingerprintOnVpnChange = true;
  mocks.fingerprintSupported = false;
  const toggle = get(render(), "fingerprint");
  expect(toggle.props.checked).toBe(true);
  expect(toggle.props.disabled).toBe(false);
  const change = toggle.props.onChange as unknown as (event: { currentTarget: { checked: boolean } }) => void;
  change({ currentTarget: { checked: false } });
  expect(mocks.setPolicy).toHaveBeenCalledWith({ rotateFingerprintOnVpnChange: false });
});

it("lets an unsupported saved site reset policy change back to pause", () => {
  mocks.policy.forbiddenAction = "resetSite";
  mocks.resetSupported = false;
  const field = get(render(), "forbidden");
  expect(field.props.disabled).toBe(false);
  field.props.onChange!("pause");
  expect(mocks.setPolicy).toHaveBeenCalledWith({ forbiddenAction: "pause" });
});

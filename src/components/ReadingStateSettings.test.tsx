import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const entry = { deviceName: "Phone backup", updatedAt: 1000, size: 2048, sha256: "a".repeat(64) };
const mocks = vi.hoisted(() => ({
  stateIndex: 0, selected: null as string | null, setState: vi.fn(), upload: vi.fn(), restore: vi.fn(), refetch: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useRef: () => ({ current: false }),
  useState: (initial: unknown) => [mocks.stateIndex++ === 0 ? mocks.selected : initial, mocks.setState],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => queryKey[1] === "name"
    ? { data: "This tablet" }
    : { data: [entry], refetch: mocks.refetch, isFetching: false, error: null },
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../store/content-sync", () => ({ useContentSyncStore: () => "" }));
vi.mock("../lib/content-sync/device-backup", () => ({
  defaultBackupDeviceName: vi.fn(), listDeviceBackups: vi.fn(), uploadDeviceBackup: mocks.upload,
  restoreDeviceBackup: mocks.restore, DeviceBackupError: class extends Error {},
}));
import { ReadingStateSettings } from "./ReadingStateSettings";
interface Props { children?: ReactNode; onClick?: () => void; disabled?: boolean; data?: unknown; }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.stateIndex = 0; mocks.selected = null;
  mocks.upload.mockResolvedValue(entry); mocks.refetch.mockResolvedValue({});
  mocks.restore.mockResolvedValue(undefined);
});
it("shows the device name and a backup action without any secret-key field", async () => {
  const elements = controls(ReadingStateSettings({ serverUrl: "http://server" }));
  expect(elements.some(item => item.props.children === "This tablet")).toBe(true);
  expect(elements.some(item => item.props.children === "readingSync.key")).toBe(false);
  const upload = elements.find(item => item.props.children === "deviceBackup.upload")!;
  expect(upload.props.disabled).toBe(false);
  upload.props.onClick!();
  await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledWith("http://server", expect.any(Function)));
  await vi.waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
});
it("requires selecting a saved device before overwrite restoration", () => {
  const elements = controls(ReadingStateSettings({ serverUrl: "http://server" }));
  const restore = elements.find(item => item.props.children === "deviceBackup.restore" && item.props.onClick)!;
  expect(restore.props.disabled).toBe(true);
});
it("offers all saved device names and requires confirmation before restoring", async () => {
  mocks.selected = entry.deviceName;
  const elements = controls(ReadingStateSettings({ serverUrl: "http://server" }));
  expect(elements.find(item => item.props.data)?.props.data).toEqual([{ value: entry.deviceName, label: entry.deviceName }]);
  elements.find(item => item.props.children === "deviceBackup.restore" && item.props.onClick)!.props.onClick!();
  expect(mocks.restore).not.toHaveBeenCalled();
  elements.find(item => item.props.children === "deviceBackup.confirmRestore")!.props.onClick!();
  await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("http://server", entry, expect.any(Function)));
});
it("disables uploads and restoration without a configured server", () => {
  const elements = controls(ReadingStateSettings({ serverUrl: "" }));
  for (const label of ["deviceBackup.upload", "deviceBackup.restore"]) {
    expect(elements.find(item => item.props.children === label && item.props.onClick)!.props.disabled).toBe(true);
  }
});

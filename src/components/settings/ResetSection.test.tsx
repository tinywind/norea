import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  keepScoped: true,
  resetAppearance: vi.fn(),
  resetReaderSettings: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [typeof initial === "boolean" ? mocks.keepScoped : initial, vi.fn()],
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn(), update: vi.fn() } }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../ui/ConfirmDialog", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("../../store/appearance", () => ({
  useAppearanceStore: (selector: (state: object) => unknown) =>
    selector({ resetAppearance: mocks.resetAppearance }),
}));
vi.mock("../../store/reader", () => ({
  useReaderStore: (selector: (state: object) => unknown) =>
    selector({ resetReaderSettings: mocks.resetReaderSettings, resetReadingProgress: vi.fn() }),
}));

import { ResetSection } from "./ResetSection";

interface Props {
  children?: ReactNode;
  label?: string;
  onClick?: () => void;
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children)];
}

function resetButton(rowLabel: string, actionLabel: string) {
  const row = elements(ResetSection({ isBusy: false, onBusyChange: vi.fn() })).find(
    (element) => element.props.label === rowLabel,
  )!;
  return elements(row.props.children).find((element) => element.props.label === actionLabel)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keepScoped = true;
});

describe("data and reset", () => {
  it("resets appearance only after confirmation", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    resetButton("settings.app.reset.label", "settings.app.reset.action").props.onClick!();
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.resetAppearance).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce(true);
    resetButton("settings.app.reset.label", "settings.app.reset.action").props.onClick!();
    await vi.waitFor(() => expect(mocks.resetAppearance).toHaveBeenCalledTimes(1));
    expect(mocks.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true, message: "settings.reset.appearance.warning" }));
  });

  it("keeps per-novel and per-source reader settings by default", async () => {
    mocks.confirm.mockResolvedValueOnce(true);
    resetButton("settings.reset.reader.label", "settings.reset.reader.action").props.onClick!();
    await vi.waitFor(() => expect(mocks.resetReaderSettings).toHaveBeenCalledWith({ keepScopedSettings: true }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "readerSettings.reset.globalMessage" }));
  });

  it("warns that every reader override goes when the keep option is off", async () => {
    mocks.keepScoped = false;
    mocks.confirm.mockResolvedValueOnce(true);
    resetButton("settings.reset.reader.label", "settings.reset.reader.action").props.onClick!();
    await vi.waitFor(() => expect(mocks.resetReaderSettings).toHaveBeenCalledWith({ keepScopedSettings: false }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "settings.reset.reader.allWarning" }));
  });
});

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePageBackNavigation } from "../../lib/android-back-navigation";
import {
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

interface OverlayProps {
  children?: ReactNode;
  onClick?: () => void;
  onClose?: () => void;
  opened?: boolean;
  title?: ReactNode;
  "data-autofocus"?: boolean;
  [key: string]: unknown;
}

const rendered = vi.hoisted(() => ({
  overlays: new Map<unknown, OverlayProps>(),
  buttons: new Map<unknown, OverlayProps>(),
}));

vi.mock("@mantine/core", () => {
  const Pass = ({ children }: OverlayProps) => children;
  const Overlay = (props: OverlayProps) => {
    rendered.overlays.set(props.title, props);
    return props.opened ? props.children : null;
  };
  const Button = (props: OverlayProps) => {
    rendered.buttons.set(props.children, props);
    return null;
  };
  return { Button, Group: Pass, Modal: Overlay, Stack: Pass, Text: () => null };
});
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ConfirmDialog, useConfirm, type ConfirmOptions } from "./ConfirmDialog";

let harness: BackNavigationHarness;
let confirm: (options: ConfirmOptions) => Promise<boolean>;
const pageBack = vi.fn(() => true);

function Page() {
  usePageBackNavigation(pageBack);
  confirm = useConfirm();
  return null;
}

function App({ dialog = true, page = true }: { dialog?: boolean; page?: boolean }) {
  return (
    <>
      {page ? <Page /> : null}
      {dialog ? <ConfirmDialog /> : null}
    </>
  );
}

const overlay = (title: string) => rendered.overlays.get(title);
const button = (label: string) => rendered.buttons.get(label)!;
const deleteOptions: ConfirmOptions = {
  title: "Delete?",
  message: "Removes 3 items.",
  confirmLabel: "Delete",
  danger: true,
};

async function request(options: ConfirmOptions): Promise<{ result: Promise<boolean> }> {
  let result!: Promise<boolean>;
  await harness.run(() => {
    result = confirm(options);
  });
  return { result };
}

beforeEach(async () => {
  rendered.overlays.clear();
  rendered.buttons.clear();
  pageBack.mockClear();
  harness = mountBackNavigationHarness();
  await harness.render(<App />);
});

afterEach(async () => {
  await harness.unmount();
});

describe("ConfirmDialog overlay contract", () => {
  it("closes on Android back as a cancel without reaching the page", async () => {
    const { result } = await request(deleteOptions);
    expect(overlay("Delete?")?.opened).toBe(true);

    expect(harness.pressBack()).toBe(true);
    await expect(result).resolves.toBe(false);
    expect(pageBack).not.toHaveBeenCalled();
    expect(overlay("Delete?")?.opened).toBe(false);

    harness.pressBack();
    expect(pageBack).toHaveBeenCalledOnce();
  });

  it("cancels through the modal close path used by Escape and the overlay", async () => {
    const { result } = await request(deleteOptions);
    await harness.run(() => overlay("Delete?")!.onClose!());
    await expect(result).resolves.toBe(false);
  });

  it("starts focus on the least destructive button for danger dialogs", async () => {
    await request(deleteOptions);
    expect(button("common.cancel")["data-autofocus"]).toBe(true);
    expect(button("Delete")["data-autofocus"]).toBeUndefined();
    expect(overlay("Delete?")).not.toHaveProperty("returnFocus", false);
    expect(overlay("Delete?")).not.toHaveProperty("trapFocus", false);
  });

  it("starts focus on the confirm button when the action is not destructive", async () => {
    await request({ title: "Install?", message: "Opens the installer.", confirmLabel: "Install" });
    expect(button("Install")["data-autofocus"]).toBe(true);
    expect(button("common.cancel")["data-autofocus"]).toBeUndefined();
  });

  it("shows concurrent requests one at a time in request order", async () => {
    const { result: first } = await request(deleteOptions);
    const { result: second } = await request({ title: "Second?", message: "Second.", confirmLabel: "Go", cancelLabel: "Keep" });
    expect(overlay("Delete?")?.opened).toBe(true);
    expect(overlay("Second?")).toBeUndefined();

    await harness.run(() => button("Delete").onClick!());
    await expect(first).resolves.toBe(true);
    expect(overlay("Second?")?.opened).toBe(true);

    await harness.run(() => button("Keep").onClick!());
    await expect(second).resolves.toBe(false);
    expect(overlay("Second?")?.opened).toBe(false);
  });

  it("resolves pending requests as cancelled when the requesting component unmounts", async () => {
    const { result: first } = await request(deleteOptions);
    const { result: second } = await request({ ...deleteOptions, title: "Second?" });

    await harness.render(<App page={false} />);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(overlay("Delete?")?.opened).toBe(false);
  });

  it("resolves pending requests as cancelled when the dialog unmounts", async () => {
    const { result } = await request(deleteOptions);
    await harness.render(<App dialog={false} />);
    await expect(result).resolves.toBe(false);
  });
});

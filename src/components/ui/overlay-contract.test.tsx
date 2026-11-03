import { Button } from "@mantine/core";
import { useState, type ReactNode } from "react";
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
  overlays: new Map<unknown, OverlayProps & { kind: string }>(),
  buttons: new Map<unknown, OverlayProps>(),
  desktop: false,
}));

vi.mock("@mantine/core", () => {
  const Pass = ({ children }: OverlayProps) => children;
  const overlay = (kind: string) => (props: OverlayProps) => {
    rendered.overlays.set(props.title, { ...props, kind });
    return props.opened ? props.children : null;
  };
  const Button = (props: OverlayProps) => {
    rendered.buttons.set(props.children, props);
    return null;
  };
  return {
    Box: Pass,
    Button,
    Drawer: overlay("drawer"),
    Group: Pass,
    Modal: overlay("modal"),
    Stack: Pass,
    Text: () => null,
  };
});
vi.mock("@mantine/hooks", () => ({ useMediaQuery: () => rendered.desktop }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ConfirmDialog, useConfirm, type ConfirmOptions } from "./ConfirmDialog";
import { ResponsiveSheet } from "./ResponsiveSheet";

let harness: BackNavigationHarness;
let confirm: (options: ConfirmOptions) => Promise<boolean>;
const pageBack = vi.fn(() => true);

let setSheetOpened: (opened: boolean) => void;

function Page() {
  usePageBackNavigation(pageBack);
  confirm = useConfirm();
  const [sheetOpened, setOpened] = useState(false);
  setSheetOpened = setOpened;
  return (
    <ResponsiveSheet
      footer={<Button>Apply</Button>}
      onClose={() => setOpened(false)}
      opened={sheetOpened}
      title="Filters"
    >
      {null}
    </ResponsiveSheet>
  );
}

function App({ dialog = true, page = true }: { dialog?: boolean; page?: boolean }) {
  return (
    <>
      {page ? <Page /> : null}
      {dialog ? <ConfirmDialog /> : null}
    </>
  );
}

async function openSheet() {
  await harness.run(() => setSheetOpened(true));
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
  rendered.desktop = false;
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

describe("ResponsiveSheet overlay contract", () => {
  it("is a bottom drawer with its footer below 768px", async () => {
    await openSheet();
    expect(overlay("Filters")).toMatchObject({ kind: "drawer", opened: true, position: "bottom" });
    expect(button("Apply")).toBeDefined();
  });

  it("is a modal from 768px up", async () => {
    rendered.desktop = true;
    await harness.render(<App />);
    await openSheet();
    expect(overlay("Filters")).toMatchObject({ kind: "modal", opened: true });
  });

  it("keeps Mantine's focus trap and focus return", async () => {
    await openSheet();
    expect(overlay("Filters")).not.toHaveProperty("trapFocus", false);
    expect(overlay("Filters")).not.toHaveProperty("returnFocus", false);
  });

  it("closes on Android back without reaching the page", async () => {
    await openSheet();

    expect(harness.pressBack()).toBe(true);
    expect(overlay("Filters")?.opened).toBe(false);
    expect(pageBack).not.toHaveBeenCalled();

    harness.pressBack();
    expect(pageBack).toHaveBeenCalledOnce();
  });

  it("closes a confirmation opened on top of it before closing itself", async () => {
    await openSheet();
    const { result } = await request(deleteOptions);

    expect(harness.pressBack()).toBe(true);
    await expect(result).resolves.toBe(false);
    expect(overlay("Filters")?.opened).toBe(true);

    expect(harness.pressBack()).toBe(true);
    expect(overlay("Filters")?.opened).toBe(false);
    expect(pageBack).not.toHaveBeenCalled();
  });

  it("leaves the sheet open when the confirmation on top is dismissed", async () => {
    await openSheet();
    const { result } = await request(deleteOptions);

    await harness.run(() => overlay("Delete?")!.onClose!());
    await expect(result).resolves.toBe(false);
    expect(overlay("Filters")?.opened).toBe(true);
  });
});

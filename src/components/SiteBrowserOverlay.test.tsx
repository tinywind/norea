import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sourceAccessCoordinator from "../lib/tasks/source-access-coordinator";
import { useSiteBrowserStore } from "../store/site-browser";
import { SiteBrowserOverlay } from "./SiteBrowserOverlay";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useEffect: vi.fn(),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("../i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../store/site-browser", async (importOriginal) => {
  const { useSiteBrowserStore: store } =
    await importOriginal<typeof import("../store/site-browser")>();
  return {
    useSiteBrowserStore: Object.assign(
      (selector: (state: ReturnType<typeof store.getState>) => unknown) =>
        selector(store.getState()),
      store,
    ),
  };
});

interface ControlProps {
  children?: ReactNode;
  disabled?: boolean;
  label?: string;
  onClick?: () => unknown;
}

function findControl(
  node: ReactNode,
  label: string,
): ReactElement<ControlProps> | undefined {
  if (!isValidElement<ControlProps>(node)) return undefined;
  if (
    node.props.onClick &&
    (node.props.label === label || node.props.children === label)
  ) {
    return node;
  }
  for (const child of Children.toArray(node.props.children)) {
    const match = findControl(child, label);
    if (match) return match;
  }
  return undefined;
}

function openBrowser(phase: "queued" | "loading" | "ready") {
  useSiteBrowserStore.getState().queueAt(
    "source-a",
    "https://source.test/chapter/1",
    "browser-task",
    {
      mode: "source-access",
      challenge: { kind: "captcha", url: "https://source.test/chapter/1" },
      revision: 3,
      scopeKey: "site:source.test",
      sourceName: "Source A",
    },
  );
  useSiteBrowserStore.setState({ phase });
  return SiteBrowserOverlay();
}

describe("source access browser controls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useSiteBrowserStore.getState().hide();
  });

  it("requests a real verification when closing the ready browser", () => {
    const overlay = openBrowser("ready");
    const close = findControl(overlay, "sourceAccess.verifyAndResume");
    expect(close).toBeDefined();
    close!.props.onClick!();

    expect(useSiteBrowserStore.getState()).toMatchObject({
      completion: { outcome: "verify", taskId: "browser-task", revision: 3 },
      visible: false,
    });
  });

  it.each(["queued", "loading"] as const)("closes a %s browser without treating it as verified", (phase) => {
    const close = findControl(openBrowser(phase), "sourceAccess.keepPaused");
    expect(close).toBeDefined();
    close!.props.onClick!();

    expect(useSiteBrowserStore.getState()).toMatchObject({
      completion: { outcome: "keep-paused" },
      visible: false,
    });
  });

  it("keeps the explicit pause action after authentication", () => {
    const pause = findControl(openBrowser("ready"), "sourceAccess.keepPaused");
    expect(pause).toBeDefined();
    pause!.props.onClick!();
    expect(useSiteBrowserStore.getState().completion?.outcome).toBe("keep-paused");
  });

  it.each(["queued", "loading", "ready"] as const)("keeps force stop available while %s", (phase) => {
    const cancel = vi.spyOn(sourceAccessCoordinator, "cancelSourceAccessWait")
      .mockReturnValue(true);
    const forceStop = findControl(
      openBrowser(phase),
      "sourceAccess.forceStopAndContinue",
    );

    expect(forceStop).toBeDefined();
    expect(forceStop!.props.disabled).not.toBe(true);
    forceStop!.props.onClick!();
    expect(cancel).toHaveBeenCalledWith("site:source.test", 3);
  });
});

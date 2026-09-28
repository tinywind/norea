import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sourceAccessCoordinator from "../lib/tasks/source-access-coordinator";
import { useSiteBrowserStore } from "../store/site-browser";
import { BlockingLoadingOverlay } from "./AppFrame";
import { SiteBrowserOverlay } from "./SiteBrowserOverlay";
import { SiteBrowserAddressBar } from "./SiteBrowserAddressBar";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useEffect: vi.fn(),
  useId: () => "loading-label",
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

  it.each(["queued", "loading", "ready"] as const)("closes a %s browser without requesting verification", (phase) => {
    const close = findControl(openBrowser(phase), "siteBrowser.close");
    expect(close).toBeDefined();
    expect(close!.props.disabled).not.toBe(true);
    close!.props.onClick!();

    expect(useSiteBrowserStore.getState()).toMatchObject({
      completion: { outcome: "keep-paused", taskId: "browser-task", revision: 3 },
      visible: false,
    });
  });

  it.each(["queued", "loading", "ready"] as const)("removes the pending task's blocking overlay while the browser is %s", (phase) => {
    const renderLoading = () => BlockingLoadingOverlay({ label: "Loading source" });
    expect(renderLoading()).not.toBeNull();

    const close = findControl(openBrowser(phase), "siteBrowser.close");
    expect(renderLoading()).toBeNull();

    close!.props.onClick!();
    expect(renderLoading()).not.toBeNull();
  });

  it("keeps the explicit pause action after authentication", () => {
    const pause = findControl(openBrowser("ready"), "sourceAccess.keepPaused");
    expect(pause).toBeDefined();
    pause!.props.onClick!();
    expect(useSiteBrowserStore.getState().completion?.outcome).toBe("keep-paused");
  });

  it("keeps the challenge and close action after a manual address change", () => {
    const view = openBrowser("ready")!;
    const bar = Children.toArray(view.props.children).find(
      (child): child is ReactElement<{ onNavigate: (url: string) => void }> =>
        isValidElement(child) && child.type === SiteBrowserAddressBar,
    );
    expect(bar).toBeDefined();
    bar!.props.onNavigate("https://other.test/login");
    expect(useSiteBrowserStore.getState()).toMatchObject({
      visible: true,
      phase: "loading",
      currentUrl: "https://other.test/login",
      taskId: "browser-task",
      sourceId: "source-a",
      context: { mode: "source-access", revision: 3, scopeKey: "site:source.test" },
    });
    findControl(SiteBrowserOverlay(), "siteBrowser.close")!.props.onClick!();
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

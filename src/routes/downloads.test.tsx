import { MantineProvider } from "@mantine/core";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadsView } from "../lib/route-search";

const mocks = vi.hoisted(() => ({
  goBackInAppHistory: vi.fn(() => false),
  navigate: vi.fn(),
  onBack: null as null | (() => void),
  tabs: null as null | {
    onChange: (value: string | null) => void;
    value: string;
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ state: { location: { href: "/downloads?view=queue" } } }),
}));
vi.mock("../lib/navigation-history", () => ({ goBackInAppHistory: mocks.goBackInAppHistory }));
vi.mock("@mantine/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mantine/core")>();
  const Tabs = Object.assign(
    (props: NonNullable<typeof mocks.tabs> & { children: ReactNode }) => {
      mocks.tabs = props;
      return <div data-tabs={props.value}>{props.children}</div>;
    },
    {
      List: ({ children, className }: { children: ReactNode; className: string }) => (
        <div className={className}>{children}</div>
      ),
      Tab: ({ children, value }: { children: ReactNode; value: string }) => <span data-tab={value}>{children}</span>,
    },
  );
  return { ...actual, Tabs };
});
vi.mock("./downloads-queue", () => ({
  DownloadsQueueView: ({ active, onBack, viewTabs }: { active: boolean; onBack: () => void; viewTabs: ReactNode }) => {
    mocks.onBack = onBack;
    return <section data-active={String(active)} data-view="queue">{viewTabs}</section>;
  },
}));
vi.mock("./downloads-storage", () => ({
  DownloadsStorageView: ({ active, onBack, viewTabs }: { active: boolean; onBack: () => void; viewTabs: ReactNode }) => {
    mocks.onBack = onBack;
    return <section data-active={String(active)} data-view="storage">{viewTabs}</section>;
  },
}));

import { mountBackNavigationHarness } from "../lib/android-back-navigation.test-support";
import { DownloadsPage } from "./downloads";

function render(view: DownloadsView, active = true): string {
  return renderToStaticMarkup(
    <MantineProvider>
      <DownloadsPage active={active} view={view} />
    </MantineProvider>,
  );
}

describe("Downloads hub", () => {
  beforeEach(() => {
    mocks.goBackInAppHistory.mockReset().mockReturnValue(false);
    mocks.navigate.mockReset();
    mocks.onBack = null;
    mocks.tabs = null;
  });

  it.each(["queue", "storage"] as const)("renders only the %s view with the bar's view tabs", (view) => {
    const markup = render(view);

    expect(markup).toContain(
      `<section data-active="true" data-view="${view}"><div data-tabs="${view}"><div class="norea-app-bar-tabs">` +
        `<span data-tab="queue">Queue</span><span data-tab="storage">Storage</span></div></div></section>`,
    );
    expect(markup.match(/data-view=/g)).toHaveLength(1);
  });

  it("passes the hidden state through to the selected view", () => {
    expect(render("storage", false)).toContain('data-active="false" data-view="storage"');
  });

  it("switches views in place without adding history entries", () => {
    render("queue");

    mocks.tabs!.onChange("storage");
    mocks.tabs!.onChange("queue");
    mocks.tabs!.onChange(null);

    expect(mocks.navigate.mock.calls).toEqual([
      [{ to: "/downloads", search: { view: "storage" }, replace: true }],
      [{ to: "/downloads", search: { view: "queue" }, replace: true }],
      [{ to: "/downloads", search: { view: "queue" }, replace: true }],
    ]);
  });

  it.each(["queue", "storage"] as const)(
    "gives the %s header the same back as Android back: the previous page, else More",
    async (view) => {
      const harness = mountBackNavigationHarness();
      function Probe() {
        mocks.onBack = (DownloadsPage({ view }) as ReactElement<{ onBack: () => void }>).props.onBack;
        return null;
      }
      try {
        await harness.render(<Probe />);

        mocks.goBackInAppHistory.mockReturnValueOnce(true);
        await harness.run(() => mocks.onBack!());
        expect(mocks.goBackInAppHistory).toHaveBeenLastCalledWith("/downloads?view=queue", ["/downloads"]);
        expect(mocks.navigate).not.toHaveBeenCalled();

        await harness.run(() => mocks.onBack!());
        expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/more", replace: true });

        mocks.navigate.mockReset();
        expect(harness.pressBack()).toBe(true);
        expect(mocks.goBackInAppHistory).toHaveBeenCalledTimes(3);
        expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/more", replace: true });
      } finally {
        await harness.unmount();
      }
    },
  );
});

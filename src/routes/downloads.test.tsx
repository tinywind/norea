import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadsView } from "../lib/route-search";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  switcher: null as null | {
    data: { label: string; value: string }[];
    onChange: (value: string) => void;
    value: string;
  },
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../components/SegmentedToggle", () => ({
  SegmentedToggle: (props: NonNullable<typeof mocks.switcher>) => {
    mocks.switcher = props;
    return <div data-switcher={props.value} />;
  },
}));
vi.mock("./downloads-queue", () => ({
  DownloadsQueueView: ({ active, viewSwitcher }: { active: boolean; viewSwitcher: ReactNode }) => (
    <section data-active={String(active)} data-view="queue">{viewSwitcher}</section>
  ),
}));
vi.mock("./downloads-storage", () => ({
  DownloadsStorageView: ({ active, viewSwitcher }: { active: boolean; viewSwitcher: ReactNode }) => (
    <section data-active={String(active)} data-view="storage">{viewSwitcher}</section>
  ),
}));

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
    mocks.navigate.mockReset();
    mocks.switcher = null;
  });

  it.each(["queue", "storage"] as const)("renders only the %s view with the view switcher", (view) => {
    const markup = render(view);

    expect(markup).toContain(`<section data-active="true" data-view="${view}"><div data-switcher="${view}"></div></section>`);
    expect(markup.match(/data-view=/g)).toHaveLength(1);
    expect(mocks.switcher?.data).toEqual([
      { value: "queue", label: "Queue" },
      { value: "storage", label: "Storage" },
    ]);
  });

  it("passes the hidden state through to the selected view", () => {
    expect(render("storage", false)).toContain('data-active="false" data-view="storage"');
  });

  it("switches views in place without adding history entries", () => {
    render("queue");

    mocks.switcher!.onChange("storage");
    mocks.switcher!.onChange("queue");
    mocks.switcher!.onChange("unknown");

    expect(mocks.navigate.mock.calls).toEqual([
      [{ to: "/downloads", search: { view: "storage" }, replace: true }],
      [{ to: "/downloads", search: { view: "queue" }, replace: true }],
      [{ to: "/downloads", search: { view: "queue" }, replace: true }],
    ]);
  });
});

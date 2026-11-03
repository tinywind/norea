import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopFileOpenHandlers } from "../lib/desktop-file-open";

const navigate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const location = vi.hoisted(() => ({
  historyIndex: 1,
  historyKey: "reader-entry",
  href: "/reader?chapterId=11",
  pathname: "/reader",
  search: { chapterId: 11 } as Record<string, unknown>,
}));
const taskAttention = vi.hoisted(() => ({ count: 0 }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
}));
vi.mock("@mantine/core", () => {
  const Container = ({ children }: { children?: ReactNode }) => children;
  const Anchor = ({
    "aria-label": label,
    children,
    className,
    to,
  }: {
    "aria-label"?: string;
    children?: ReactNode;
    className?: string;
    to?: string;
  }) => (
    <a aria-label={label} className={className} href={to}>
      {children}
    </a>
  );
  return {
    Anchor,
    AppShell: Object.assign(Container, { Navbar: Container, Main: Container }),
    MantineProvider: Container,
  };
});
vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  Outlet: () => null,
  useNavigate: () => navigate,
  useRouterState: () => location,
}));
vi.mock("../lib/android-back-navigation", () => ({
  startAndroidBackNavigationBridge: vi.fn(),
}));
vi.mock("../lib/android-file-open", () => ({
  startAndroidFileOpenListener: vi.fn(),
}));
vi.mock("../lib/desktop-file-open", () => ({
  startDesktopFileOpenListener: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../lib/deep-link", () => ({
  startDeepLinkListener: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../lib/system-file-import", () => ({
  importSystemOpenedFile: vi.fn(),
}));
vi.mock("../lib/tasks/hooks", () => ({
  useTaskAttentionCount: () => taskAttention.count,
}));
vi.mock("../components/SiteBrowserOverlay", () => ({ SiteBrowserOverlay: () => null }));
vi.mock("../components/TaskNotifications", () => ({ TaskNotifications: () => null }));
vi.mock("../components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../components/library/use-window-file-drop-import", () => ({ useWindowFileDropImport: () => undefined }));
vi.mock("../components/runtime/use-first-run-setup-redirect", () => ({ useFirstRunSetupRedirect: () => undefined }));
vi.mock("./browse", () => ({ BrowsePage: () => null }));
vi.mock("./downloads", () => ({
  DownloadsPage: ({ view }: { view: string }) => (
    <div data-downloads-view={view} />
  ),
}));
vi.mock("./history", () => ({ HistoryPage: () => null }));
vi.mock("./library", () => ({ LibraryPage: () => null }));
vi.mock("./more", () => ({ MorePage: () => null }));
vi.mock("./novel", () => ({ NovelDetailPage: () => null }));
vi.mock("./novel-merge", () => ({ NovelMergePage: () => null }));
vi.mock("./reader", () => ({ ReaderPage: () => null }));
vi.mock("./settings", () => ({ SettingsPage: () => null }));
vi.mock("./source", () => ({ SourcePage: () => null }));
vi.mock("./updates", () => ({ UpdatesPage: () => null }));

import { startDeepLinkListener } from "../lib/deep-link";
import { startDesktopFileOpenListener } from "../lib/desktop-file-open";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
} from "../lib/reader-query-invalidation";
import { importSystemOpenedFile } from "../lib/system-file-import";
import { RootLayout } from "./__root";

describe("system file opening from an active reader", () => {
  let queryClient: QueryClient;
  let handlers: DesktopFileOpenHandlers;
  let cleanups: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanups = [];
    queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, retry: false } },
    });
    renderToStaticMarkup(
      <MantineProvider>
        <QueryClientProvider client={queryClient}>
          <RootLayout />
        </QueryClientProvider>
      </MantineProvider>,
    );
    cleanups = vi.mocked(useEffect).mock.calls.flatMap(([effect]) => {
      const cleanup = effect();
      return typeof cleanup === "function" ? [cleanup] : [];
    });
    handlers = vi.mocked(startDesktopFileOpenListener).mock.calls.at(-1)![0];
  });

  afterEach(() => {
    cleanups.forEach((cleanup) => cleanup());
    queryClient.clear();
  });

  it("opens the imported chapter when another chapter is already open", async () => {
    vi.mocked(importSystemOpenedFile).mockResolvedValue({
      chapterId: 12,
      novelId: 3,
    });

    await handlers.onFiles([new File(["# New chapter"], "new.md")]);

    expect(navigate).toHaveBeenCalledWith({
      to: "/reader",
      search: { chapterId: 12 },
    });
  });

  it("opens the latest imported chapter when external opens arrive in a batch", async () => {
    const files = [
      new File(["# Earlier chapter"], "earlier.md"),
      new File(["# Latest chapter"], "latest.md"),
    ];
    vi.mocked(importSystemOpenedFile)
      .mockResolvedValueOnce({ chapterId: 11, novelId: 3 })
      .mockResolvedValueOnce({ chapterId: 12, novelId: 3 });

    await handlers.onFiles(files);

    expect(importSystemOpenedFile).toHaveBeenNthCalledWith(1, files[0]);
    expect(importSystemOpenedFile).toHaveBeenNthCalledWith(2, files[1]);
    expect(navigate).toHaveBeenCalledWith({
      to: "/reader",
      search: { chapterId: 12 },
    });
  });

  it("reloads cached content when the system reopens an imported chapter", async () => {
    let content = "Old content";
    const options = {
      queryKey: chapterDetailQueryKey(11),
      queryFn: async () => content,
    };
    await queryClient.fetchQuery(options);
    vi.mocked(importSystemOpenedFile).mockImplementation(async () => {
      content = "Updated content";
      return { chapterId: 11, novelId: 3 };
    });

    await handlers.onFiles([new File(["Updated content"], "chapter.md")]);

    expect(await queryClient.fetchQuery(options)).toBe("Updated content");
  });

  it("reloads the reader chapter list after importing into its current work", async () => {
    let chapters = [11];
    const options = {
      queryKey: chapterListQueryKey(3),
      queryFn: async () => chapters,
    };
    await queryClient.fetchQuery(options);
    vi.mocked(importSystemOpenedFile).mockImplementation(async () => {
      chapters = [11, 12];
      return { chapterId: 12, novelId: 3 };
    });

    await handlers.onFiles([new File(["# New chapter"], "new.md")]);

    expect(await queryClient.fetchQuery(options)).toEqual([11, 12]);
  });
});

describe("primary navigation", () => {
  const readerLocation = { ...location };

  function renderNavigation(pathname: string): string {
    Object.assign(location, { href: pathname, pathname, search: {} });
    return renderToStaticMarkup(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <RootLayout />
        </QueryClientProvider>
      </MantineProvider>,
    );
  }

  function navLinks(markup: string, linkClassName: string) {
    return [
      ...markup.matchAll(
        /<a aria-label="([^"]*)" class="([^"]*)" href="([^"]*)">(.*?)<\/a>/g,
      ),
    ]
      .filter(([, , className]) => className.split(" ").includes(linkClassName))
      .map(([, label, className, href, content]) => ({
        active: className.includes("--active"),
        content,
        href,
        label,
      }));
  }

  afterEach(() => {
    Object.assign(location, readerLocation);
    taskAttention.count = 0;
  });

  it("offers Library, Updates, History, Browse and More in both navs", () => {
    const markup = renderNavigation("/");
    const expected = [
      { href: "/", label: "Library" },
      { href: "/updates", label: "Updates" },
      { href: "/history", label: "History" },
      { href: "/browse", label: "Browse" },
      { href: "/more", label: "More" },
    ];
    const destinations = (linkClassName: string) =>
      navLinks(markup, linkClassName).map(({ href, label }) => ({ href, label }));

    expect(destinations("norea-rail-link")).toEqual(expected);
    expect(destinations("norea-mobile-nav-link")).toEqual(expected);
  });

  it("renders the rail brand as plain content and no nested main landmark", () => {
    const markup = renderNavigation("/");

    expect(markup).toContain('<div class="norea-rail-brand">');
    expect(markup).not.toContain("<main");
  });

  it("badges More with active and failed tasks", () => {
    taskAttention.count = 120;
    const markup = renderNavigation("/");
    const more = navLinks(markup, "norea-rail-link").find(
      (link) => link.href === "/more",
    );

    expect(more?.label).toBe("More, 120 active or failed tasks");
    expect(more?.content).toContain(
      '<span aria-hidden="true" class="norea-rail-badge">99+</span>',
    );
    expect(markup.match(/norea-rail-badge/g)).toHaveLength(2);
  });

  it("shows no badge when no task needs attention", () => {
    expect(renderNavigation("/")).not.toContain("norea-rail-badge");
  });

  it.each(["/more", "/downloads", "/settings"])(
    "marks More as current on %s",
    (pathname) => {
      const active = navLinks(renderNavigation(pathname), "norea-mobile-nav-link")
        .filter((link) => link.active)
        .map((link) => link.href);

      expect(active).toEqual(["/more"]);
    },
  );

  it("marks only Library as current on the library page", () => {
    const active = navLinks(renderNavigation("/"), "norea-rail-link")
      .filter((link) => link.active)
      .map((link) => link.href);

    expect(active).toEqual(["/"]);
  });
});

describe("Downloads hub routing", () => {
  const readerLocation = { ...location };

  function render(pathname: string, search: Record<string, unknown>): string {
    Object.assign(location, { href: pathname, pathname, search });
    return renderToStaticMarkup(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <RootLayout />
        </QueryClientProvider>
      </MantineProvider>,
    );
  }

  afterEach(() => {
    Object.assign(location, readerLocation);
  });

  it.each([
    [{ view: "storage" }, "storage"],
    [{ view: "queue" }, "queue"],
    [{ view: "tasks" }, "queue"],
    [{}, "queue"],
  ])("renders the persistent Downloads page for %j as the %s view", (search, view) => {
    expect(render("/downloads", search)).toContain(`data-downloads-view="${view}"`);
  });

  it("no longer serves the removed /tasks route", () => {
    const markup = render("/tasks", {});

    expect(markup).not.toContain("data-downloads-view");
    expect(markup).not.toContain("--active");
  });
});

describe("task notification deep links", () => {
  let cleanups: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    renderToStaticMarkup(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <RootLayout />
        </QueryClientProvider>
      </MantineProvider>,
    );
    cleanups = vi.mocked(useEffect).mock.calls.flatMap(([effect]) => {
      const cleanup = effect();
      return typeof cleanup === "function" ? [cleanup] : [];
    });
  });

  afterEach(() => {
    cleanups.forEach((cleanup) => cleanup());
  });

  it("opens the download queue as a new history entry for norea://tasks", async () => {
    const handlers = vi.mocked(startDeepLinkListener).mock.calls.at(-1)![0];

    handlers.onTaskNotificationAction?.({ type: "openTasks" });

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/downloads",
        search: { view: "queue" },
      }),
    );
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

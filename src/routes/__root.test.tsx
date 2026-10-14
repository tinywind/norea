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
  search: { chapterId: 11 },
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
}));
vi.mock("@mantine/core", () => {
  const Container = ({ children }: { children?: ReactNode }) => children;
  return {
    Anchor: Container,
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
vi.mock("../components/SiteBrowserOverlay", () => ({ SiteBrowserOverlay: () => null }));
vi.mock("../components/TaskNotifications", () => ({ TaskNotifications: () => null }));
vi.mock("./browse", () => ({ BrowsePage: () => null }));
vi.mock("./downloads", () => ({ DownloadsPage: () => null }));
vi.mock("./history", () => ({ HistoryPage: () => null }));
vi.mock("./library", () => ({ LibraryPage: () => null }));
vi.mock("./novel", () => ({ NovelDetailPage: () => null }));
vi.mock("./novel-merge", () => ({ NovelMergePage: () => null }));
vi.mock("./reader", () => ({ ReaderPage: () => null }));
vi.mock("./settings", () => ({ SettingsPage: () => null }));
vi.mock("./source", () => ({ SourcePage: () => null }));
vi.mock("./tasks", () => ({ TasksPage: () => null }));
vi.mock("./updates", () => ({ UpdatesPage: () => null }));

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

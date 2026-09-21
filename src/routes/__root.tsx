import { memo, useEffect, useState } from "react";
import { Anchor, AppShell } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { PageSlot } from "../components/PageSlot";
import { SiteBrowserOverlay } from "../components/SiteBrowserOverlay";
import { TaskNotifications } from "../components/TaskNotifications";
import { useTranslation, type TranslationKey } from "../i18n";
import { startAndroidBackNavigationBridge } from "../lib/android-back-navigation";
import { startAndroidFileOpenListener } from "../lib/android-file-open";
import { startDesktopFileOpenListener } from "../lib/desktop-file-open";
import { startDeepLinkListener } from "../lib/deep-link";
import {
  getAppNavigationHistoryIndex,
  recordAppNavigationEntry,
} from "../lib/navigation-history";
import {
  pageInstanceKey,
  readHistoryEntryKey,
  reducePageStack,
  type PageStackEntry,
  type PageStackOptions,
} from "../lib/page-stack";
import {
  parseNovelMergeSearch,
  parseNovelSearch,
  parseReaderSearch,
  parseSourceSearch,
} from "../lib/route-search";
import { importSystemOpenedFile } from "../lib/system-file-import";
import { isAndroidRuntime, isTauriRuntime } from "../lib/tauri-runtime";
import { useAppearanceStore } from "../store/appearance";
import { useBrowseStore } from "../store/browse";
import { useLibraryStore } from "../store/library";
import { useReaderStore } from "../store/reader";
import { BrowsePage, type BrowseTab } from "./browse";
import { DownloadsPage } from "./downloads";
import { HistoryPage } from "./history";
import { LibraryPage } from "./library";
import { NovelDetailPage } from "./novel";
import { NovelMergePage } from "./novel-merge";
import { ReaderPage } from "./reader";
import { SettingsPage } from "./settings";
import { SourcePage } from "./source";
import { TasksPage } from "./tasks";
import { UpdatesPage } from "./updates";

const PersistentLibraryPage = memo(LibraryPage);
const PersistentBrowsePage = memo(BrowsePage);
const PersistentUpdatesPage = memo(UpdatesPage);
const PersistentHistoryPage = memo(HistoryPage);
const PersistentDownloadsPage = memo(DownloadsPage);
const PersistentTasksPage = memo(TasksPage);
const PersistentSettingsPage = memo(SettingsPage);
const StackedNovelPage = memo(NovelDetailPage);
const StackedNovelMergePage = memo(NovelMergePage);
const StackedReaderPage = memo(ReaderPage);
const StackedSourcePage = memo(SourcePage);

const MAX_HIDDEN_STACKED_PAGES = 6;
const PAGE_STACK_OPTIONS: PageStackOptions = {
  maxHiddenEntries: MAX_HIDDEN_STACKED_PAGES,
  singleInstancePathnames: new Set(["/reader"]),
  stackedPathnames: new Set(["/novel", "/novel-merge", "/reader", "/source"]),
};

type NavItem = {
  compactKey: TranslationKey;
  icon:
    | "library"
    | "browse"
    | "updates"
    | "history"
    | "downloads"
    | "tasks"
    | "settings";
  labelKey: TranslationKey;
  to:
    | "/"
    | "/browse"
    | "/updates"
    | "/history"
    | "/downloads"
    | "/tasks"
    | "/settings";
  visibleWhen?: "updates" | "history" | "downloads" | "tasks";
};

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", labelKey: "nav.library", compactKey: "nav.library", icon: "library" },
  {
    to: "/browse",
    labelKey: "nav.browse",
    compactKey: "nav.browse",
    icon: "browse",
  },
  {
    to: "/updates",
    labelKey: "nav.updates",
    compactKey: "nav.updates",
    icon: "updates",
    visibleWhen: "updates",
  },
  {
    to: "/history",
    labelKey: "nav.history",
    compactKey: "nav.history",
    icon: "history",
    visibleWhen: "history",
  },
  {
    to: "/downloads",
    labelKey: "nav.downloads",
    compactKey: "nav.downloads",
    icon: "downloads",
    visibleWhen: "downloads",
  },
  {
    to: "/tasks",
    labelKey: "nav.tasks",
    compactKey: "nav.tasks",
    icon: "tasks",
    visibleWhen: "tasks",
  },
  {
    to: "/settings",
    labelKey: "nav.settings",
    compactKey: "nav.settings",
    icon: "settings",
  },
] as const;

type PersistentPage =
  | "library"
  | "browse"
  | "updates"
  | "history"
  | "downloads"
  | "tasks"
  | "settings";

function getPersistentPage(pathname: string): PersistentPage | null {
  switch (pathname) {
    case "/":
      return "library";
    case "/browse":
      return "browse";
    case "/updates":
      return "updates";
    case "/history":
      return "history";
    case "/downloads":
      return "downloads";
    case "/tasks":
      return "tasks";
    case "/settings":
      return "settings";
    default:
      return null;
  }
}

function getSearchString(
  search: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = search[key];
  return typeof value === "string" ? value : fallback;
}

function getBrowseTab(search: Record<string, unknown>): BrowseTab {
  return search.tab === "sources" ? "sources" : "search";
}

function asSearchRecord(search: unknown): Record<string, unknown> {
  return search !== null && typeof search === "object"
    ? (search as Record<string, unknown>)
    : {};
}

function StackedPage({ entry }: { entry: PageStackEntry }) {
  switch (entry.pathname) {
    case "/novel":
      return <StackedNovelPage id={parseNovelSearch(entry.search).id} />;
    case "/novel-merge":
      return (
        <StackedNovelMergePage
          sourceNovelId={parseNovelMergeSearch(entry.search).sourceNovelId}
        />
      );
    case "/reader":
      return (
        <StackedReaderPage
          chapterId={parseReaderSearch(entry.search).chapterId}
        />
      );
    case "/source": {
      const { pluginId, query } = parseSourceSearch(entry.search);
      return <StackedSourcePage pluginId={pluginId} query={query} />;
    }
    default:
      return null;
  }
}

function isNavItemVisible(
  item: NavItem,
  visible: {
    downloads: boolean;
    history: boolean;
    tasks: boolean;
    updates: boolean;
  },
): boolean {
  if (item.visibleWhen === "history") return visible.history;
  if (item.visibleWhen === "updates") return visible.updates;
  if (item.visibleWhen === "downloads") return visible.downloads;
  if (item.visibleWhen === "tasks") return visible.tasks;
  return true;
}

function NavIcon({ icon }: { icon: NavItem["icon"] }) {
  const common = {
    "aria-hidden": true,
    fill: "none",
    height: 24,
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 2,
    viewBox: "0 0 24 24",
    width: 24,
  };

  switch (icon) {
    case "library":
      return (
        <svg {...common}>
          <path d="M4 4h4v16H4z" />
          <path d="M10 4h4v16h-4z" />
          <path d="m16 6 4-1 3 15-4 1z" />
        </svg>
      );
    case "browse":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18" />
          <path d="M12 3a14 14 0 0 0 0 18" />
        </svg>
      );
    case "updates":
      return (
        <svg {...common}>
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 4v5h-5" />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "downloads":
      return (
        <svg {...common}>
          <path d="M4 5h16v4H4z" />
          <path d="M6 9v10h12V9" />
          <path d="M9 14h6" />
          <path d="m12 11 3 3-3 3" />
        </svg>
      );
    case "tasks":
      return (
        <svg {...common}>
          <path d="M4 6h16" />
          <path d="M4 12h16" />
          <path d="M4 18h10" />
          <path d="M8 6v0" />
          <path d="M8 12v0" />
          <path d="M8 18v0" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}

function AppNavLink({
  activeClassName,
  className,
  item,
  label,
}: {
  activeClassName: string;
  className: string;
  item: NavItem;
  label: string;
}) {
  return (
    <Anchor
      activeOptions={{ exact: item.to === "/" }}
      activeProps={{ className: `${className} ${activeClassName}` }}
      aria-label={label}
      className={className}
      component={Link}
      title={label}
      to={item.to}
      underline="never"
    >
      <span className="norea-rail-icon">
        <NavIcon icon={item.icon} />
      </span>
      <span className="norea-rail-label">{label}</span>
    </Anchor>
  );
}

export function RootLayout() {
  const { t } = useTranslation();
  const showLabelsInNav = useAppearanceStore((s) => s.showLabelsInNav);
  const showHistoryTab = useAppearanceStore((s) => s.showHistoryTab);
  const showUpdatesTab = useAppearanceStore((s) => s.showUpdatesTab);
  const showDownloadsTab = useAppearanceStore((s) => s.showDownloadsTab);
  const showTasksTab = useAppearanceStore((s) => s.showTasksTab);
  const fullPageReaderActive = useReaderStore(
    (state) => state.fullPageReaderActive,
  );
  const fullPageReaderChromeVisible = useReaderStore(
    (state) => state.fullPageReaderChromeVisible,
  );
  const location = useRouterState({
    select: (state) => ({
      historyIndex: getAppNavigationHistoryIndex(state.location.state),
      historyKey: readHistoryEntryKey(state.location.state),
      href: state.location.href,
      pathname: state.location.pathname,
      search: state.location.search,
    }),
  });
  const pathname = location.pathname;
  const search = asSearchRecord(location.search);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const activePersistentPage = getPersistentPage(pathname);
  const stackLocation = {
    historyIndex: location.historyIndex ?? 0,
    historyKey: location.historyKey ?? String(location.historyIndex ?? 0),
    pathname,
    search,
  };
  const [pageStack, setPageStack] = useState<readonly PageStackEntry[]>([]);
  const nextPageStack = reducePageStack(
    pageStack,
    stackLocation,
    PAGE_STACK_OPTIONS,
  );
  if (nextPageStack !== pageStack) setPageStack(nextPageStack);
  const activeStackKey = PAGE_STACK_OPTIONS.stackedPathnames.has(pathname)
    ? pageInstanceKey(stackLocation, PAGE_STACK_OPTIONS)
    : null;
  const [visitedPages, setVisitedPages] = useState<ReadonlySet<PersistentPage>>(
    () =>
      new Set<PersistentPage>(
        activePersistentPage ? [activePersistentPage] : [],
      ),
  );
  const [lastBrowseQuery, setLastBrowseQuery] = useState(() =>
    getSearchString(search, "q", ""),
  );
  const [lastBrowseTab, setLastBrowseTab] = useState<BrowseTab>(() =>
    getBrowseTab(search),
  );
  const [lastSettingsSection, setLastSettingsSection] = useState(() =>
    getSearchString(search, "section", "app"),
  );
  const browseQuery =
    activePersistentPage === "browse"
      ? getSearchString(search, "q", "")
      : lastBrowseQuery;
  const browseTab =
    activePersistentPage === "browse" ? getBrowseTab(search) : lastBrowseTab;
  const settingsSection =
    activePersistentPage === "settings"
      ? getSearchString(search, "section", "app")
      : lastSettingsSection;

  useEffect(() => {
    recordAppNavigationEntry({
      historyIndex: location.historyIndex,
      href: location.href,
      pathname,
    });
  }, [location.historyIndex, location.href, pathname]);

  useEffect(() => startAndroidBackNavigationBridge(), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    startDeepLinkListener({
      onRepoAdd: (repoUrl) => {
        useBrowseStore.getState().setPendingRepoUrl(repoUrl);
        void navigate({
          to: "/browse",
          search: { q: "", tab: "sources" },
        });
      },
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        // Plugin not initialized (e.g. running outside Tauri host
        // for vite-only dev). Listener registration silently no-ops.
      });
    return () => {
      unlisten?.();
    };
  }, [navigate]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const startFileOpenListener = isAndroidRuntime()
      ? startAndroidFileOpenListener
      : startDesktopFileOpenListener;
    startFileOpenListener({
      onError: (error) => {
        console.error("[file-open] failed to open file", error);
      },
      onFiles: async (files) => {
        const failedFiles: File[] = [];
        let chapterId: number | undefined;

        for (const file of files) {
          try {
            const imported = await importSystemOpenedFile(file);
            chapterId ??= imported.chapterId;
          } catch (error) {
            console.error("[file-open] failed to import file", error);
            failedFiles.push(file);
          }
        }

        if (failedFiles.length > 0) {
          useLibraryStore.getState().queueLocalImportFiles(failedFiles);
        }
        if (chapterId !== undefined) {
          void queryClient.invalidateQueries({ queryKey: ["category"] });
          void queryClient.invalidateQueries({ queryKey: ["novel"] });
          await navigate({ to: "/reader", search: { chapterId } });
        } else if (failedFiles.length > 0) {
          await navigate({ to: "/" });
        }
      },
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((error) => {
        if (isTauriRuntime()) {
          console.error("[file-open] failed to start listener", error);
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate, queryClient]);

  useEffect(() => {
    if (activePersistentPage) {
      setVisitedPages((current) => {
        if (current.has(activePersistentPage)) return current;
        return new Set([...current, activePersistentPage]);
      });
    }

    if (activePersistentPage === "browse") {
      const nextQuery = getSearchString(search, "q", "");
      setLastBrowseQuery((current) =>
        current === nextQuery ? current : nextQuery,
      );
      const nextTab = getBrowseTab(search);
      setLastBrowseTab((current) =>
        current === nextTab ? current : nextTab,
      );
    }

    if (activePersistentPage === "settings") {
      const nextSection = getSearchString(search, "section", "app");
      setLastSettingsSection((current) =>
        current === nextSection ? current : nextSection,
      );
    }
  }, [activePersistentPage, search]);

  const pageVisited = (page: PersistentPage) =>
    visitedPages.has(page) || activePersistentPage === page;
  const readerFullPageActive = pathname === "/reader" && fullPageReaderActive;
  const mobileNavVisible = !readerFullPageActive || fullPageReaderChromeVisible;
  const navItems = NAV_ITEMS.filter((item) =>
    isNavItemVisible(item, {
      downloads: showDownloadsTab,
      history: showHistoryTab,
      tasks: showTasksTab,
      updates: showUpdatesTab,
    }),
  );

  return (
    <AppShell
      navbar={{
        width: showLabelsInNav
          ? { sm: "3.5rem", "1201px": "11.5rem" }
          : "3.5rem",
        breakpoint: "sm",
        collapsed: { mobile: true, desktop: readerFullPageActive },
      }}
      padding={0}
    >
      <AppShell.Navbar className="norea-app-rail" data-show-labels={showLabelsInNav}>
        <Anchor
          aria-label="Norea"
          className="norea-rail-brand"
          component={Link}
          to="/"
          underline="never"
        >
          <img
            alt=""
            aria-hidden="true"
            className="norea-rail-mark"
            src="/app-icon.svg"
          />
          <span className="norea-rail-title">Norea</span>
        </Anchor>
        <nav
          className="norea-rail-nav"
          data-show-labels={showLabelsInNav}
          aria-label={t("nav.primary")}
        >
          {navItems.map((item) => (
            <AppNavLink
              activeClassName="norea-rail-link--active"
              className="norea-rail-link"
              item={item}
              key={item.to}
              label={t(item.labelKey)}
            />
          ))}
        </nav>
      </AppShell.Navbar>
      <AppShell.Main
        className="norea-app-main"
        data-reader-full-page={readerFullPageActive}
        style={{
          background: "var(--norea-design-bg)",
          color: "var(--norea-design-ink)",
          padding: readerFullPageActive ? 0 : undefined,
        }}
      >
        <div className="norea-app-scroll">
          {pageVisited("library") ? (
            <PageSlot active={activePersistentPage === "library"}>
              <PersistentLibraryPage
                active={activePersistentPage === "library"}
              />
            </PageSlot>
          ) : null}
          {pageVisited("browse") ? (
            <PageSlot active={activePersistentPage === "browse"}>
              <PersistentBrowsePage
                active={activePersistentPage === "browse"}
                query={browseQuery}
                tab={browseTab}
              />
            </PageSlot>
          ) : null}
          {pageVisited("updates") ? (
            <PageSlot active={activePersistentPage === "updates"}>
              <PersistentUpdatesPage
                active={activePersistentPage === "updates"}
              />
            </PageSlot>
          ) : null}
          {pageVisited("history") ? (
            <PageSlot active={activePersistentPage === "history"}>
              <PersistentHistoryPage />
            </PageSlot>
          ) : null}
          {pageVisited("downloads") ? (
            <PageSlot active={activePersistentPage === "downloads"}>
              <PersistentDownloadsPage
                active={activePersistentPage === "downloads"}
              />
            </PageSlot>
          ) : null}
          {pageVisited("tasks") ? (
            <PageSlot active={activePersistentPage === "tasks"}>
              <PersistentTasksPage active={activePersistentPage === "tasks"} />
            </PageSlot>
          ) : null}
          {pageVisited("settings") ? (
            <PageSlot active={activePersistentPage === "settings"}>
              <PersistentSettingsPage section={settingsSection} />
            </PageSlot>
          ) : null}
          {nextPageStack.map((entry) => (
            <PageSlot
              active={entry.instanceKey === activeStackKey}
              key={entry.instanceKey}
            >
              <StackedPage entry={entry} />
            </PageSlot>
          ))}
          {activePersistentPage === null && activeStackKey === null ? (
            <Outlet />
          ) : null}
        </div>
      </AppShell.Main>
      <nav
        className="norea-mobile-nav"
        data-reader-full-page={readerFullPageActive}
        data-reader-visible={mobileNavVisible}
        data-show-labels={showLabelsInNav}
        aria-label={t("nav.primary")}
      >
        {navItems.map((item) => (
          <AppNavLink
            activeClassName="norea-mobile-nav-link--active"
            className="norea-mobile-nav-link"
            item={item}
            key={item.to}
            label={t(item.compactKey)}
          />
        ))}
      </nav>
      <SiteBrowserOverlay />
      <TaskNotifications />
    </AppShell>
  );
}

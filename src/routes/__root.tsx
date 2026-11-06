import { memo, useEffect, useRef, useState } from "react";
import { Anchor, AppShell } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { PageSlot } from "../components/PageSlot";
import {
  applyAutomaticExtensionUpdates,
  refreshStaleRepositoryIndexesAtLaunch,
  reportAutomaticExtensionUpdates,
} from "../components/browse/use-plugin-catalog";
import { SiteBrowserOverlay } from "../components/SiteBrowserOverlay";
import { TaskNotifications } from "../components/TaskNotifications";
import { ContentDeletionDialog } from "../components/ContentDeletionDialog";
import { useWindowFileDropImport } from "../components/library/use-window-file-drop-import";
import { useFirstRunSetupRedirect } from "../components/runtime/use-first-run-setup-redirect";
import { useAutomaticBackup } from "../lib/backup/use-automatic-backup";
import { syncStoredPluginVpnProfiles } from "../lib/plugin-vpn-profiles";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import {
  BrowseIcon,
  HistoryIcon,
  LibraryIcon,
  MoreIcon,
  UpdatesIcon,
  type AppIcon,
} from "../components/ui/icons";
import { useTranslation, type TranslationKey } from "../i18n";
import { startAndroidBackNavigationBridge } from "../lib/android-back-navigation";
import { startAndroidFileOpenListener } from "../lib/android-file-open";
import { startDesktopFileOpenListener } from "../lib/desktop-file-open";
import { startDeepLinkListener } from "../lib/deep-link";
import { useTaskAttentionCount } from "../lib/tasks/hooks";
import { useNewChapterBadgeCount } from "../components/updates/use-new-chapter-badge";
import {
  applyTaskNotificationAction,
  navigateToTaskNotificationDestination,
} from "../lib/tasks/task-notification-actions";
import {
  getAppNavigationHistoryIndex,
  isOpenedFromMore,
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
  parseDownloadsSearch,
  parseNovelMergeSearch,
  parseNovelSearch,
  parseReaderSearch,
  parseSourceSearch,
  type DownloadsView,
} from "../lib/route-search";
import { importSystemOpenedFile } from "../lib/system-file-import";
import { isAndroidRuntime, isTauriRuntime } from "../lib/tauri-runtime";
import { useBodyFlag } from "../lib/use-body-flag";
import { useAppearanceStore } from "../store/appearance";
import { useBrowseStore } from "../store/browse";
import { useLibraryStore } from "../store/library";
import { BrowsePage, type BrowseTab } from "./browse";
import { DownloadsPage } from "./downloads";
import { HistoryPage } from "./history";
import { LibraryPage } from "./library";
import { MorePage } from "./more";
import { NovelDetailPage } from "./novel";
import { NovelMergePage } from "./novel-merge";
import { ReaderPage } from "./reader";
import { SettingsPage } from "./settings";
import { SourcePage } from "./source";
import { UpdatesPage } from "./updates";

const PersistentLibraryPage = memo(LibraryPage);
const PersistentBrowsePage = memo(BrowsePage);
const PersistentUpdatesPage = memo(UpdatesPage);
const PersistentHistoryPage = memo(HistoryPage);
const PersistentDownloadsPage = memo(DownloadsPage);
const PersistentSettingsPage = memo(SettingsPage);
const PersistentMorePage = memo(MorePage);
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
  icon: AppIcon;
  labelKey: TranslationKey;
  to: "/" | "/updates" | "/history" | "/browse" | "/more";
};

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", labelKey: "nav.library", compactKey: "nav.library", icon: LibraryIcon },
  {
    to: "/browse",
    labelKey: "nav.browse",
    compactKey: "nav.browse",
    icon: BrowseIcon,
  },
  {
    to: "/updates",
    labelKey: "nav.updates",
    compactKey: "nav.updates",
    icon: UpdatesIcon,
  },
  {
    to: "/history",
    labelKey: "nav.history",
    compactKey: "nav.history",
    icon: HistoryIcon,
  },
  {
    to: "/more",
    labelKey: "nav.more",
    compactKey: "nav.more",
    icon: MoreIcon,
  },
] as const;

/** Destinations opened from More keep the More item marked as current. */
const MORE_PATHNAMES: ReadonlySet<string> = new Set([
  "/more",
  "/downloads",
  "/settings",
]);

function isNavItemActive(
  item: NavItem,
  pathname: string,
  openedFromMore: boolean,
): boolean {
  if (openedFromMore) return item.to === "/more";
  if (item.to === "/") return pathname === "/";
  if (item.to === "/more") return MORE_PATHNAMES.has(pathname);
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

type PersistentPage =
  | "library"
  | "browse"
  | "updates"
  | "history"
  | "downloads"
  | "settings"
  | "more";

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
    case "/settings":
      return "settings";
    case "/more":
      return "more";
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
  return search.tab === "server" ? "server" : "search";
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

function formatNavBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function AppNavLink({
  active,
  activeClassName,
  badgeCount = 0,
  className,
  item,
  label,
}: {
  active: boolean;
  activeClassName: string;
  badgeCount?: number;
  className: string;
  item: NavItem;
  label: string;
}) {
  const { t } = useTranslation();
  const accessibleLabel = badgeCount <= 0
    ? label
    : t(item.to === "/updates" ? "nav.newChapters" : "nav.taskAttention", { label, count: badgeCount });

  return (
    <Anchor
      activeOptions={{ exact: item.to === "/" }}
      aria-label={accessibleLabel}
      className={`${active ? `${className} ${activeClassName}` : className} norea-state-layer`}
      component={Link}
      title={accessibleLabel}
      to={item.to}
      underline="never"
    >
      <span className="norea-rail-icon">
        <item.icon />
      </span>
      <span className="norea-rail-label">{label}</span>
      {badgeCount > 0 ? (
        <span aria-hidden="true" className="norea-rail-badge">
          {formatNavBadge(badgeCount)}
        </span>
      ) : null}
    </Anchor>
  );
}

function NavLinks({
  activeClassName,
  className,
  labelKey,
  openedFromMore,
  pathname,
}: {
  activeClassName: string;
  className: string;
  labelKey: "compactKey" | "labelKey";
  openedFromMore: boolean;
  pathname: string;
}) {
  const { t } = useTranslation();
  const taskAttentionCount = useTaskAttentionCount();
  const newChapterCount = useNewChapterBadgeCount();

  return NAV_ITEMS.map((item) => (
    <AppNavLink
      active={isNavItemActive(item, pathname, openedFromMore)}
      activeClassName={activeClassName}
      badgeCount={item.to === "/more" ? taskAttentionCount : item.to === "/updates" ? newChapterCount : 0}
      className={className}
      item={item}
      key={item.to}
      label={t(item[labelKey])}
    />
  ));
}

export function RootLayout() {
  const { t } = useTranslation();
  const notificationTranslateRef = useRef(t);
  notificationTranslateRef.current = t;
  const showLabelsInNav = useAppearanceStore((s) => s.showLabelsInNav);
  const location = useRouterState({
    select: (state) => ({
      historyIndex: getAppNavigationHistoryIndex(state.location.state),
      historyKey: readHistoryEntryKey(state.location.state),
      href: state.location.href,
      openedFromMore: isOpenedFromMore(state.location.state),
      pathname: state.location.pathname,
      search: state.location.search,
    }),
  });
  const pathname = location.pathname;
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
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
  const [lastDownloadsView, setLastDownloadsView] = useState<DownloadsView>(
    () => parseDownloadsSearch(search).view,
  );
  const [lastSettingsSection, setLastSettingsSection] = useState(() =>
    getSearchString(search, "section", ""),
  );
  const browseQuery =
    activePersistentPage === "browse"
      ? getSearchString(search, "q", "")
      : lastBrowseQuery;
  const browseTab =
    activePersistentPage === "browse" ? getBrowseTab(search) : lastBrowseTab;
  const downloadsView =
    activePersistentPage === "downloads"
      ? parseDownloadsSearch(search).view
      : lastDownloadsView;
  const settingsSection =
    activePersistentPage === "settings"
      ? getSearchString(search, "section", "")
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
    if (!isTauriRuntime()) return;
    void refreshStaleRepositoryIndexesAtLaunch(queryClient)
      .catch((error) => console.warn("[browse:repository] launch index refresh failed", error))
      .then(async () => {
        if (!useBrowseStore.getState().autoUpdateExtensions) return;
        reportAutomaticExtensionUpdates(await applyAutomaticExtensionUpdates(queryClient));
      })
      .catch((error) => console.warn("[browse:repository] automatic extension updates failed", error));
  }, [queryClient]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    startDeepLinkListener({
      onRepoAdd: (repoUrl) => {
        if (disposed) return;
        useBrowseStore.getState().setPendingRepoUrl(repoUrl);
        // The first-run setup prefills its repository step from the pending URL.
        if (pathnameRef.current === "/setup") return;
        void navigate({ to: "/browse/extensions", search: {} });
      },
      onTaskNotificationAction: action => {
        if (disposed) return;
        void applyTaskNotificationAction(
          action,
          (destination) => navigateToTaskNotificationDestination(navigate, destination),
          notificationTranslateRef.current,
        ).catch(error => console.warn("[task-notifications] deep-link action failed", error));
      },
    })
      .then((cleanup) => {
        if (disposed) { cleanup(); return; }
        unlisten = cleanup;
      })
      .catch(() => {
        // Plugin not initialized (e.g. running outside Tauri host
        // for vite-only dev). Listener registration silently no-ops.
      });
    return () => {
      disposed = true;
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
            chapterId = imported.chapterId;
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
          void queryClient.invalidateQueries({ queryKey: ["chapter"] });
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

    if (activePersistentPage === "downloads") {
      const nextView = parseDownloadsSearch(search).view;
      setLastDownloadsView((current) =>
        current === nextView ? current : nextView,
      );
    }

    if (activePersistentPage === "settings") {
      const nextSection = getSearchString(search, "section", "");
      setLastSettingsSection((current) =>
        current === nextSection ? current : nextSection,
      );
    }
  }, [activePersistentPage, search]);

  const pageVisited = (page: PersistentPage) =>
    visitedPages.has(page) || activePersistentPage === page;
  const readerActive = pathname === "/reader";
  useBodyFlag("reader-active", readerActive);
  useWindowFileDropImport(!isAndroidRuntime());
  useFirstRunSetupRedirect(pathname);
  useAutomaticBackup();
  useEffect(() => {
    void syncStoredPluginVpnProfiles();
  }, []);
  const setupActive = pathname === "/setup";

  return (
    <AppShell
      navbar={{
        width: showLabelsInNav
          ? { sm: "3.5rem", "1200px": "11.5rem" }
          : "3.5rem",
        breakpoint: "sm",
        collapsed: { mobile: true, desktop: readerActive || setupActive },
      }}
      padding={0}
    >
      <AppShell.Navbar className="norea-app-rail" data-show-labels={showLabelsInNav}>
        <div className="norea-rail-brand">
          <img
            alt=""
            aria-hidden="true"
            className="norea-rail-mark"
            src="/app-icon.svg"
          />
          <span className="norea-rail-title">Norea</span>
        </div>
        <nav
          className="norea-rail-nav"
          data-show-labels={showLabelsInNav}
          aria-label={t("nav.primary")}
        >
          <NavLinks
            activeClassName="norea-rail-link--active"
            className="norea-rail-link"
            labelKey="labelKey"
            openedFromMore={location.openedFromMore}
            pathname={pathname}
          />
        </nav>
      </AppShell.Navbar>
      <AppShell.Main
        className="norea-app-main"
        data-reader-active={readerActive}
        style={{
          background: "var(--norea-color-bg)",
          color: "var(--norea-color-ink)",
          padding: readerActive ? 0 : undefined,
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
                view={downloadsView}
              />
            </PageSlot>
          ) : null}
          {pageVisited("settings") ? (
            <PageSlot active={activePersistentPage === "settings"}>
              <PersistentSettingsPage section={settingsSection} />
            </PageSlot>
          ) : null}
          {pageVisited("more") ? (
            <PageSlot active={activePersistentPage === "more"}>
              <PersistentMorePage />
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
        data-hidden={setupActive}
        data-reader-active={readerActive}
        data-show-labels={showLabelsInNav}
        aria-label={t("nav.primary")}
      >
        <NavLinks
          activeClassName="norea-mobile-nav-link--active"
          className="norea-mobile-nav-link"
          labelKey="compactKey"
          openedFromMore={location.openedFromMore}
          pathname={pathname}
        />
      </nav>
      <SiteBrowserOverlay />
      <TaskNotifications />
      <ContentDeletionDialog />
      <ConfirmDialog />
    </AppShell>
  );
}

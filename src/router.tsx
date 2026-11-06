import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  parseDownloadsSearch,
  parseNovelMergeSearch,
  parseNovelSearch,
  parseReaderSearch,
  parseSourceSearch,
} from "./lib/route-search";
import { RootLayout } from "./routes/__root";
import { BrowsePage, type BrowseTab } from "./routes/browse";
import { DownloadsPage } from "./routes/downloads";
import { ExtensionsPage } from "./routes/extensions";
import { HistoryPage } from "./routes/history";
import { LibraryPage } from "./routes/library";
import { MorePage } from "./routes/more";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";
import { UpdatesPage } from "./routes/updates";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LibraryPage,
});

export const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/browse",
  validateSearch: (
    search: Record<string, unknown>,
  ): { q: string; tab: BrowseTab } => ({
    q: typeof search.q === "string" ? search.q : "",
    tab: search.tab === "server" ? "server" : "search",
  }),
  component: BrowseRoutePage,
});

export const extensionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/browse/extensions",
  validateSearch: (search: Record<string, unknown>): { plugin?: string } =>
    typeof search.plugin === "string" && search.plugin !== ""
      ? { plugin: search.plugin }
      : {},
  component: ExtensionsRoutePage,
});

const readerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reader",
  validateSearch: parseReaderSearch,
});

const novelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/novel",
  validateSearch: parseNovelSearch,
});

const novelMergeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/novel-merge",
  validateSearch: parseNovelMergeSearch,
});

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: (search: Record<string, unknown>) => ({
    section: typeof search.section === "string" ? search.section : undefined,
  }),
  component: SettingsRoutePage,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryPage,
});

const updatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/updates",
  component: UpdatesPage,
});

const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/downloads",
  validateSearch: parseDownloadsSearch,
  component: DownloadsRoutePage,
});

const moreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/more",
  component: MorePage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const sourceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/source",
  validateSearch: parseSourceSearch,
});

const routeTree = rootRoute.addChildren([
  libraryRoute,
  browseRoute,
  extensionsRoute,
  readerRoute,
  settingsRoute,
  novelRoute,
  novelMergeRoute,
  historyRoute,
  updatesRoute,
  downloadsRoute,
  moreRoute,
  sourceRoute,
  setupRoute,
]);

export const router = createRouter({ routeTree });

function BrowseRoutePage() {
  const { q, tab } = browseRoute.useSearch();
  return <BrowsePage query={q} tab={tab} />;
}

function ExtensionsRoutePage() {
  const { plugin } = extensionsRoute.useSearch();
  return <ExtensionsPage focusPluginId={plugin} />;
}

function DownloadsRoutePage() {
  const { view } = downloadsRoute.useSearch();
  return <DownloadsPage view={view} />;
}

function SettingsRoutePage() {
  const { section } = settingsRoute.useSearch();
  return <SettingsPage section={section} />;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

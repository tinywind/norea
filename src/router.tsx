import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  parseNovelMergeSearch,
  parseNovelSearch,
  parseReaderSearch,
  parseSourceSearch,
} from "./lib/route-search";
import { RootLayout } from "./routes/__root";
import { BrowsePage, type BrowseTab } from "./routes/browse";
import { DownloadsPage } from "./routes/downloads";
import { HistoryPage } from "./routes/history";
import { LibraryPage } from "./routes/library";
import { SettingsPage } from "./routes/settings";
import { TasksPage } from "./routes/tasks";
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
    tab: search.tab === "sources" ? "sources" : "search",
  }),
  component: BrowseRoutePage,
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
  component: DownloadsPage,
});

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: TasksPage,
});

const sourceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/source",
  validateSearch: parseSourceSearch,
});

const routeTree = rootRoute.addChildren([
  libraryRoute,
  browseRoute,
  readerRoute,
  settingsRoute,
  novelRoute,
  novelMergeRoute,
  historyRoute,
  updatesRoute,
  downloadsRoute,
  tasksRoute,
  sourceRoute,
]);

export const router = createRouter({ routeTree });

function BrowseRoutePage() {
  const { q, tab } = browseRoute.useSearch();
  return <BrowsePage query={q} tab={tab} />;
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

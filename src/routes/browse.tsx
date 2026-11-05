import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Indicator, Tabs } from "@mantine/core";
import { PageFrame, PageHeader } from "../components/AppFrame";
import { BrowseSearchTab } from "../components/browse/BrowseSearchTab";
import { BrowseServerTab } from "../components/browse/BrowseServerTab";
import { BrowseSourcesTab } from "../components/browse/BrowseSourcesTab";
import { IconButton } from "../components/IconButton";
import {
  useInstalledPlugins,
  usePluginUpdateCount,
} from "../components/browse/use-plugin-catalog";
import { ExtensionsIcon } from "../components/ui/icons";
import { useTranslation } from "../i18n";
import { useContentSyncStore } from "../store/content-sync";
import "../styles/browse.css";

export type BrowseTab = "search" | "sources" | "server";

interface BrowsePageProps {
  active?: boolean;
  query?: string;
  tab?: BrowseTab;
}

export function BrowsePage({
  active = true,
  query: q = "",
  tab = "search",
}: BrowsePageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const installed = useInstalledPlugins(active && tab !== "server");
  const serverConfigured = useContentSyncStore((state) => state.serverUrl !== "");
  const showServerTab = serverConfigured || tab === "server";
  const installedPlugins = installed.data ?? [];
  const updateCount = usePluginUpdateCount(active);
  const [serverSelecting, setServerSelecting] = useState(false);
  const [selectionHeaderSlot, setSelectionHeaderSlot] = useState<HTMLDivElement | null>(null);
  const selecting = serverSelecting && tab === "server";

  const header = (
    <PageHeader
      actions={
        <Indicator
          disabled={updateCount === 0}
          label={updateCount > 99 ? "99+" : updateCount}
          offset={6}
          size={16}
        >
          <IconButton
            label={
              updateCount > 0
                ? t("browse.extensionsWithUpdates", { count: updateCount })
                : t("extensions.title")
            }
            onClick={() => {
              void navigate({ to: "/browse/extensions", search: {} });
            }}
            size="lg"
          >
            <ExtensionsIcon />
          </IconButton>
        </Indicator>
      }
      title={t("browse.title")}
    >
      <Tabs.List className="norea-app-bar-tabs">
        <Tabs.Tab value="search">{t("browse.tab.search")}</Tabs.Tab>
        <Tabs.Tab value="sources">{t("browse.tab.sources")}</Tabs.Tab>
        {showServerTab ? (
          <Tabs.Tab value="server">{t("browse.tab.server")}</Tabs.Tab>
        ) : null}
      </Tabs.List>
    </PageHeader>
  );

  return (
    <Tabs
      className="norea-browse-page"
      value={tab}
      onChange={(value) => {
        const nextTab: BrowseTab =
          value === "server" ? "server" : value === "sources" ? "sources" : "search";
        void navigate({
          to: "/browse",
          search: { q, tab: nextTab },
          replace: true,
        });
      }}
    >
      {selecting ? (
        <div className="norea-browse-selection-header" ref={setSelectionHeaderSlot} />
      ) : (
        header
      )}

      <PageFrame size="wide" className="norea-browse-frame">
        <Tabs.Panel value="search" className="norea-browse-tab-panel">
          {active && tab === "search" ? (
            <BrowseSearchTab
              installedPlugins={installedPlugins}
              query={q}
              onSearch={(nextQuery) => {
                void navigate({
                  to: "/browse",
                  search: { q: nextQuery, tab: "search" },
                });
              }}
            />
          ) : null}
        </Tabs.Panel>

        <Tabs.Panel value="sources" className="norea-browse-tab-panel">
          {tab === "sources" ? <BrowseSourcesTab active={active} /> : null}
        </Tabs.Panel>

        {showServerTab ? (
          <Tabs.Panel value="server" className="norea-browse-tab-panel">
            {active && tab === "server" ? (
              <BrowseServerTab
                active
                onSelectionModeChange={setServerSelecting}
                selectionHeaderSlot={selecting ? selectionHeaderSlot : null}
              />
            ) : null}
          </Tabs.Panel>
        ) : null}
      </PageFrame>
    </Tabs>
  );
}

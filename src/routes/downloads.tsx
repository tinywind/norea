import { Tabs } from "@mantine/core";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useTranslation } from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import { goBackInAppHistory } from "../lib/navigation-history";
import { parseDownloadsSearch, type DownloadsView } from "../lib/route-search";
import { DownloadsQueueView } from "./downloads-queue";
import { DownloadsStorageView } from "./downloads-storage";
import "../styles/downloads.css";

interface DownloadsPageProps {
  active?: boolean;
  view: DownloadsView;
}

export function DownloadsPage({ active = true, view }: DownloadsPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const router = useRouter();
  // Downloads lives under More, so a cold start leaves to More.
  const leaveDownloads = () => {
    if (goBackInAppHistory(router.state.location.href, ["/downloads"])) return;
    void navigate({ to: "/more", replace: true });
  };
  usePageBackNavigation(() => {
    leaveDownloads();
    return true;
  });
  // The two views fill the bar as underline tabs, as Browse and Library categories do.
  const viewTabs = (
    <Tabs
      className="norea-downloads-view-tabs"
      onChange={(value) => {
        void navigate({
          to: "/downloads",
          search: parseDownloadsSearch({ view: value }),
          replace: true,
        });
      }}
      value={view}
    >
      <Tabs.List aria-label={t("downloads.view.label")} className="norea-app-bar-tabs">
        <Tabs.Tab value="queue">{t("downloads.view.queue")}</Tabs.Tab>
        <Tabs.Tab value="storage">{t("downloads.view.storage")}</Tabs.Tab>
      </Tabs.List>
    </Tabs>
  );

  return view === "storage" ? (
    <DownloadsStorageView active={active} onBack={leaveDownloads} viewTabs={viewTabs} />
  ) : (
    <DownloadsQueueView active={active} onBack={leaveDownloads} viewTabs={viewTabs} />
  );
}

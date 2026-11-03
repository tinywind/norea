import { useNavigate } from "@tanstack/react-router";
import { SegmentedToggle } from "../components/SegmentedToggle";
import { useTranslation } from "../i18n";
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
  const viewSwitcher = (
    <SegmentedToggle
      aria-label={t("downloads.view.label")}
      className="norea-downloads-view-switch"
      data={[
        { value: "queue", label: t("downloads.view.queue") },
        { value: "storage", label: t("downloads.view.storage") },
      ]}
      onChange={(value) => {
        void navigate({
          to: "/downloads",
          search: parseDownloadsSearch({ view: value }),
          replace: true,
        });
      }}
      value={view}
    />
  );

  return view === "storage" ? (
    <DownloadsStorageView active={active} viewSwitcher={viewSwitcher} />
  ) : (
    <DownloadsQueueView active={active} viewSwitcher={viewSwitcher} />
  );
}

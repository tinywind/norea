import { useNavigate, useRouter } from "@tanstack/react-router";
import { SegmentedToggle } from "../components/SegmentedToggle";
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
    <DownloadsStorageView active={active} onBack={leaveDownloads} viewSwitcher={viewSwitcher} />
  ) : (
    <DownloadsQueueView active={active} onBack={leaveDownloads} viewSwitcher={viewSwitcher} />
  );
}

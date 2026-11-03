import { Switch } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { PageFrame, PageHeader } from "../components/AppFrame";
import {
  AboutIcon,
  ChevronRightIcon,
  DownloadsIcon,
  SettingsIcon,
  type AppIcon,
} from "../components/ui/icons";
import { useTranslation } from "../i18n";
import { useTaskAttentionCount } from "../lib/tasks/hooks";
import { useLibraryStore } from "../store/library";
import "../styles/more.css";

const ROW_CLASS_NAME = "norea-more-row norea-state-layer";

function MoreLinkRow({
  badge,
  description,
  icon: Icon,
  label,
  to,
  section,
}: {
  badge?: number;
  description?: string;
  icon: AppIcon;
  label: string;
  to: "/downloads" | "/settings";
  section?: string;
}) {
  const content = (
    <>
      <Icon className="norea-more-row-icon" />
      <span className="norea-more-row-copy">
        <span className="norea-more-row-label">{label}</span>
        {description ? (
          <span className="norea-more-row-description">{description}</span>
        ) : null}
      </span>
      {badge ? <span className="norea-more-row-badge">{badge}</span> : null}
      <ChevronRightIcon className="norea-more-row-chevron" />
    </>
  );
  return (
    <li>
      {to === "/settings" ? (
        <Link className={ROW_CLASS_NAME} search={{ section }} to="/settings">
          {content}
        </Link>
      ) : (
        <Link
          className={ROW_CLASS_NAME}
          search={{ view: "queue" }}
          to="/downloads"
        >
          {content}
        </Link>
      )}
    </li>
  );
}

export function MorePage() {
  const { t } = useTranslation();
  const incognitoMode = useLibraryStore((state) => state.incognitoMode);
  const setIncognitoMode = useLibraryStore((state) => state.setIncognitoMode);
  const taskAttentionCount = useTaskAttentionCount();

  return (
    <PageFrame className="norea-more-page" size="narrow">
      <PageHeader title={t("more.title")} />
      <div className="norea-more-group">
        <Switch
          checked={incognitoMode}
          className="norea-more-switch"
          description={t("more.pauseHistory.description")}
          label={t("more.pauseHistory")}
          labelPosition="left"
          onChange={(event) => setIncognitoMode(event.currentTarget.checked)}
        />
      </div>
      <ul className="norea-more-group norea-more-list">
        <MoreLinkRow
          badge={taskAttentionCount}
          description={t("more.downloads.description")}
          icon={DownloadsIcon}
          label={t("downloads.title")}
          to="/downloads"
        />
        <MoreLinkRow
          icon={SettingsIcon}
          label={t("nav.settings")}
          to="/settings"
        />
        <MoreLinkRow
          icon={AboutIcon}
          label={t("settings.category.about.title")}
          section="about"
          to="/settings"
        />
      </ul>
    </PageFrame>
  );
}

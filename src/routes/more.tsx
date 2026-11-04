import { Switch, VisuallyHidden } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageFrame } from "../components/AppFrame";
import { usePluginUpdateCount } from "../components/browse/use-plugin-catalog";
import { buildVersionLabel } from "../components/settings/use-app-updates";
import {
  AboutIcon,
  ChevronRightIcon,
  DownloadsIcon,
  ExtensionsIcon,
  SettingsIcon,
  type AppIcon,
} from "../components/ui/icons";
import { useTranslation } from "../i18n";
import { OPENED_FROM_MORE_STATE } from "../lib/navigation-history";
import { getBuildInfo } from "../lib/update";
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
  to: "/downloads" | "/browse/extensions" | "/settings";
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
        <Link
          className={ROW_CLASS_NAME}
          search={{ section }}
          state={OPENED_FROM_MORE_STATE}
          to="/settings"
        >
          {content}
        </Link>
      ) : to === "/browse/extensions" ? (
        <Link
          className={ROW_CLASS_NAME}
          search={{}}
          state={OPENED_FROM_MORE_STATE}
          to="/browse/extensions"
        >
          {content}
        </Link>
      ) : (
        <Link
          className={ROW_CLASS_NAME}
          search={{ view: "queue" }}
          state={OPENED_FROM_MORE_STATE}
          to="/downloads"
        >
          {content}
        </Link>
      )}
    </li>
  );
}

/** The installed version for the page's identity line; About reports a failure to read it. */
function useAppVersionLabel(): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getBuildInfo()
      .then((info) => {
        if (!cancelled) setLabel(buildVersionLabel(info));
      })
      .catch((error: unknown) => {
        console.warn("[more] could not read the build info:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return label;
}

export function MorePage() {
  const { t } = useTranslation();
  const incognitoMode = useLibraryStore((state) => state.incognitoMode);
  const setIncognitoMode = useLibraryStore((state) => state.setIncognitoMode);
  const taskAttentionCount = useTaskAttentionCount();
  const pluginUpdateCount = usePluginUpdateCount(true);
  const versionLabel = useAppVersionLabel();

  return (
    <PageFrame className="norea-more-page" size="narrow">
      {/* More carries no page-level controls, so it draws no bar; the nav names the page. */}
      <VisuallyHidden component="h1">{t("more.title")}</VisuallyHidden>
      <div className="norea-more-identity">
        <span className="norea-more-identity-name">{t("more.appName")}</span>
        {versionLabel ? <span className="norea-more-identity-version">{versionLabel}</span> : null}
      </div>
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
          badge={pluginUpdateCount}
          icon={ExtensionsIcon}
          label={t("extensions.title")}
          to="/browse/extensions"
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

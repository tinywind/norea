import { useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "@mantine/hooks";
import { PageFrame } from "../components/AppFrame";
import { IconButton } from "../components/IconButton";
import { LibrarySettingsPanel } from "../components/LibrarySettingsPanel";
import { AboutSection } from "../components/settings/AboutSection";
import { AppearanceSection } from "../components/settings/AppearanceSection";
import { BackupSection } from "../components/settings/BackupSection";
import { BrowseSection } from "../components/settings/BrowseSection";
import { DeveloperSection } from "../components/settings/DeveloperSection";
import { DownloadsSection } from "../components/settings/DownloadsSection";
import { GeneralSection } from "../components/settings/GeneralSection";
import { NetworkSection } from "../components/settings/NetworkSection";
import { ReaderSection } from "../components/settings/ReaderSection";
import { ResetSection } from "../components/settings/ResetSection";
import {
  SettingsIndex,
  type SettingsIndexEntry,
} from "../components/settings/SettingsIndex";
import type { SettingsBusyProps } from "../components/settings/settings-busy";
import { SETTINGS_SECTION_TITLE_KEYS } from "../components/settings/settings-section-titles";
import {
  openSettingsSearchResult,
  SettingsSearch,
  useSettingsRevealScroll,
} from "../components/settings/SettingsSearch";
import type { SettingsSearchResult } from "../components/settings/settings-search-index";
import { BackIcon } from "../components/ui/icons";
import { useTranslation } from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import {
  SETTINGS_SECTION_IDS,
  useSettingsSection,
  type SettingsSectionId,
} from "../lib/use-settings-section";
import "../styles/settings.css";

function SettingsSectionContent({
  busy,
  id,
}: {
  busy: SettingsBusyProps;
  id: SettingsSectionId;
}): ReactNode {
  switch (id) {
    case "appearance":
      return <AppearanceSection />;
    case "general":
      return <GeneralSection />;
    case "reader":
      return <ReaderSection />;
    case "library":
      return <LibrarySettingsPanel />;
    case "downloads":
      return <DownloadsSection isBusy={busy.isBusy} />;
    case "backup":
      return <BackupSection {...busy} />;
    case "browse":
      return <BrowseSection />;
    case "network":
      return <NetworkSection isBusy={busy.isBusy} />;
    case "reset":
      return <ResetSection {...busy} />;
    case "about":
      return <AboutSection />;
    case "developer":
      return <DeveloperSection {...busy} />;
  }
}

function SettingsDetail({
  children,
  id,
  onBack,
}: {
  children: ReactNode;
  id: SettingsSectionId;
  /** Shown on phones, where the section replaces the index. */
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  useSettingsRevealScroll(bodyRef, id);

  return (
    <section
      className="norea-settings-detail"
      aria-labelledby={`settings-${id}-title`}
    >
      <header className="norea-settings-app-bar">
        {onBack ? (
          <IconButton label={t("common.back")} onClick={onBack} size="lg">
            <BackIcon />
          </IconButton>
        ) : null}
        <h1 className="norea-settings-app-bar-title" id={`settings-${id}-title`}>
          {t(SETTINGS_SECTION_TITLE_KEYS[id])}
        </h1>
      </header>
      <div className="norea-settings-detail-body" ref={bodyRef}>
        {children}
      </div>
    </section>
  );
}

interface SettingsPageProps {
  section?: string;
}

export function SettingsPage({ section }: SettingsPageProps = {}) {
  const { t } = useTranslation();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [selectedSection, selectSection] = useSettingsSection(section);
  const [searchQuery, setSearchQuery] = useState("");
  const selectSearchResult = (result: SettingsSearchResult) =>
    openSettingsSearchResult(result, selectSection);
  const searching = searchQuery.trim() !== "";
  const wide = useMediaQuery("(min-width: 768px)", undefined, {
    getInitialValueInEffect: false,
  });
  const busy: SettingsBusyProps = {
    isBusy: busyAction !== null,
    onBusyChange: setBusyAction,
  };
  const entries: SettingsIndexEntry[] = SETTINGS_SECTION_IDS.map((id) => ({
    id,
    title: t(SETTINGS_SECTION_TITLE_KEYS[id]),
  }));

  usePageBackNavigation(() => {
    if (wide || selectedSection === null) return false;
    selectSection(null);
    return true;
  });

  if (wide) {
    const activeSection = selectedSection ?? SETTINGS_SECTION_IDS[0];
    return (
      <PageFrame className="norea-settings-page" size="full">
        <div className="norea-settings-shell">
          <aside className="norea-settings-nav">
            <header className="norea-settings-app-bar">
              <h1 className="norea-settings-app-bar-title">{t("settings.title")}</h1>
            </header>
            <div className="norea-settings-nav-scroll">
              <SettingsSearch
                onQueryChange={setSearchQuery}
                onSelect={selectSearchResult}
                query={searchQuery}
              />
              {searching ? null : (
                <SettingsIndex
                  activeId={activeSection}
                  entries={entries}
                  onSelect={selectSection}
                />
              )}
            </div>
          </aside>
          <SettingsDetail id={activeSection}>
            <SettingsSectionContent busy={busy} id={activeSection} />
          </SettingsDetail>
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame className="norea-settings-page" size="full">
      <div className="norea-settings-shell">
        {selectedSection === null ? (
          <section className="norea-settings-detail" aria-labelledby="settings-index-title">
            <header className="norea-settings-app-bar">
              <h1 className="norea-settings-app-bar-title" id="settings-index-title">
                {t("settings.title")}
              </h1>
            </header>
            <div className="norea-settings-detail-body">
              <SettingsSearch
                onQueryChange={setSearchQuery}
                onSelect={selectSearchResult}
                query={searchQuery}
              />
              {searching ? null : (
                <SettingsIndex entries={entries} onSelect={selectSection} />
              )}
            </div>
          </section>
        ) : (
          <SettingsDetail id={selectedSection} onBack={() => selectSection(null)}>
            <SettingsSectionContent busy={busy} id={selectedSection} />
          </SettingsDetail>
        )}
      </div>
    </PageFrame>
  );
}

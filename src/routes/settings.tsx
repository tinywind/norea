import { useState, type ReactNode } from "react";
import { Box, Group, ScrollArea, Select, Stack, Text, Title } from "@mantine/core";
import { PageFrame } from "../components/AppFrame";
import { LibrarySettingsPanel } from "../components/LibrarySettingsPanel";
import { ReaderSettingsPanel } from "../components/ReaderSettingsPanel";
import { AboutSection } from "../components/settings/AboutSection";
import { AppearanceSection } from "../components/settings/AppearanceSection";
import { BackupSection } from "../components/settings/BackupSection";
import { DeveloperSection } from "../components/settings/DeveloperSection";
import { DownloadsSection } from "../components/settings/DownloadsSection";
import { GeneralSection } from "../components/settings/GeneralSection";
import { NetworkSection } from "../components/settings/NetworkSection";
import { ResetSection } from "../components/settings/ResetSection";
import {
  SettingsIndex,
  type SettingsIndexEntry,
} from "../components/settings/SettingsIndex";
import type { SettingsBusyProps } from "../components/settings/settings-busy";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  SETTINGS_SECTION_IDS,
  useSettingsSection,
  type SettingsSectionId,
} from "../lib/use-settings-section";
import "../styles/settings.css";

const SECTION_TITLE_KEYS: Record<SettingsSectionId, TranslationKey> = {
  appearance: "settings.category.appearance.title",
  general: "settings.category.general.title",
  reader: "settings.category.reader.title",
  library: "settings.category.library.title",
  downloads: "settings.category.downloads.title",
  backup: "settings.category.backup.title",
  network: "settings.category.network.title",
  reset: "settings.category.reset.title",
  about: "settings.category.about.title",
  developer: "settings.category.developer.title",
};

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
      return <ReaderSettingsPanel />;
    case "library":
      return <LibrarySettingsPanel />;
    case "downloads":
      return <DownloadsSection isBusy={busy.isBusy} />;
    case "backup":
      return <BackupSection {...busy} />;
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
  entries,
  id,
  children,
  onSelect,
}: {
  entries: readonly SettingsIndexEntry[];
  id: SettingsSectionId;
  children: ReactNode;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const { t } = useTranslation();
  const title = t(SECTION_TITLE_KEYS[id]);

  return (
    <section
      className="norea-settings-detail"
      aria-labelledby={`settings-${id}-title`}
    >
      <div className="norea-settings-detail-inner">
        <Group
          className="norea-settings-detail-header"
          align="center"
          justify="flex-start"
          wrap="wrap"
        >
          <Box className="norea-settings-detail-copy">
            <Title
              className="norea-settings-detail-title"
              id={`settings-${id}-title`}
              order={1}
            >
              {title}
            </Title>
          </Box>
          <Select
            allowDeselect={false}
            aria-label={t("settings.sectionSelect.label")}
            className="norea-settings-section-select"
            data={entries.map((entry) => ({
              value: entry.id,
              label: entry.title,
            }))}
            value={id}
            onChange={(value) => {
              const next = entries.find((entry) => entry.id === value);
              if (next) onSelect(next.id);
            }}
          />
        </Group>

        <Stack className="norea-settings-detail-body" gap="md">
          {children}
        </Stack>
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
  const activeSection = selectedSection ?? SETTINGS_SECTION_IDS[0];
  const busy: SettingsBusyProps = {
    isBusy: busyAction !== null,
    onBusyChange: setBusyAction,
  };
  const entries: SettingsIndexEntry[] = SETTINGS_SECTION_IDS.map((id) => ({
    id,
    title: t(SECTION_TITLE_KEYS[id]),
  }));

  return (
    <PageFrame className="norea-settings-page" size="full">
      <div className="norea-settings-shell">
        <aside className="norea-settings-nav">
          <div className="norea-settings-nav-header">
            <Text className="norea-console-kicker">{t("settings.title")}</Text>
          </div>
          <ScrollArea className="norea-settings-nav-scroll">
            <SettingsIndex
              activeId={activeSection}
              entries={entries}
              onSelect={selectSection}
            />
          </ScrollArea>
        </aside>
        <SettingsDetail entries={entries} id={activeSection} onSelect={selectSection}>
          <SettingsSectionContent busy={busy} id={activeSection} />
        </SettingsDetail>
      </div>
    </PageFrame>
  );
}

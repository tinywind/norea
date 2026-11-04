import { Stack } from "@mantine/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ConsoleChip } from "../ConsolePrimitives";
import {
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
} from "../SettingsPrimitives";
import { TextButton } from "../TextButton";
import { describeError } from "../../lib/errors";
import { useTranslation } from "../../i18n";
import { showSettingsToast } from "./settings-toast";
import {
  canInstallUpdate,
  updateStatusLabel,
  useAppUpdates,
} from "./use-app-updates";

const LATEST_RELEASE_URL = "https://github.com/tinywind/norea/releases/latest";

export function AboutSection() {
  const { t } = useTranslation();
  const updates = useAppUpdates("official");
  const buildVersion = updates.buildInfo?.buildVersion
    ? `v${updates.buildInfo.buildVersion}`
    : "";

  function openLatestRelease(): void {
    void openUrl(LATEST_RELEASE_URL).catch((error: unknown) => {
      showSettingsToast(
        "danger",
        t("settings.about.githubReleases"),
        t("settings.data.openReleaseFailed", {
          error: describeError(error),
        }),
      );
    });
  }

  return (
    <Stack gap="md">
      <SettingsSection title={t("settings.about.build.title")}>
        <SettingsFieldRow
          label={t("settings.about.version.label")}
          description={t("settings.about.version.description")}
        >
          {buildVersion ? <ConsoleChip tone="accent">{buildVersion}</ConsoleChip> : null}
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.officialUpdate.label")}
          description={t("settings.about.officialUpdate.description")}
        >
          <SettingsInlineControls>
            {updates.candidate ? (
              <ConsoleChip>{updateStatusLabel(t, updates.candidate)}</ConsoleChip>
            ) : null}
            <TextButton
              loading={updates.checking}
              disabled={!updates.buildInfo || updates.busy}
              onClick={() => {
                void updates.checkUpdate();
              }}
            >
              {t("settings.about.update.check")}
            </TextButton>
            <TextButton
              variant="default"
              loading={updates.installing}
              disabled={!canInstallUpdate(updates.candidate) || updates.busy}
              onClick={() => {
                void updates.installCandidate();
              }}
            >
              {t("settings.about.update.install")}
            </TextButton>
          </SettingsInlineControls>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.latestRelease.label")}
          description={t("settings.about.latestRelease.description")}
        >
          <TextButton variant="default" onClick={openLatestRelease}>
            {t("settings.about.githubReleases")}
          </TextButton>
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}

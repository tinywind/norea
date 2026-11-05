import { Stack } from "@mantine/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ConsoleChip } from "../ConsolePrimitives";
import {
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
} from "../SettingsPrimitives";
import { IconButton } from "../IconButton";
import { TextButton } from "../TextButton";
import { DownloadIcon, RefreshIcon } from "../ui/icons";
import { describeError } from "../../lib/errors";
import { useTranslation } from "../../i18n";
import { showSettingsToast } from "./settings-toast";
import {
  buildIdentityLabel,
  buildVersionLabel,
  canInstallUpdate,
  updateStatusLabel,
  useAppUpdates,
} from "./use-app-updates";

const LATEST_RELEASE_URL = "https://github.com/tinywind/norea/releases/latest";

export function AboutSection() {
  const { t } = useTranslation();
  const updates = useAppUpdates("official");
  const buildInfo = updates.buildInfo;
  const buildIdentity = buildInfo ? buildIdentityLabel(t, buildInfo) : null;

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
          {buildInfo ? (
            <SettingsInlineControls>
              <ConsoleChip>{buildVersionLabel(buildInfo)}</ConsoleChip>
              {buildIdentity ? <ConsoleChip>{buildIdentity}</ConsoleChip> : null}
            </SettingsInlineControls>
          ) : null}
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.officialUpdate.label")}
          description={t("settings.about.officialUpdate.description")}
        >
          <SettingsInlineControls>
            {updates.candidate ? (
              <ConsoleChip>{updateStatusLabel(t, updates.candidate)}</ConsoleChip>
            ) : null}
            <IconButton
              label={t("settings.about.update.check")}
              size="lg"
              loading={updates.checking}
              disabled={!updates.buildInfo || updates.busy}
              onClick={() => {
                void updates.checkUpdate();
              }}
            >
              <RefreshIcon />
            </IconButton>
            <IconButton
              label={t("settings.about.update.install")}
              size="lg"
              loading={updates.installing}
              disabled={!canInstallUpdate(updates.candidate) || updates.busy}
              onClick={() => {
                void updates.installCandidate();
              }}
            >
              <DownloadIcon />
            </IconButton>
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

import {
  NumberInput,
  Stack,
} from "@mantine/core";
import { SettingsFieldRow, SettingsSection } from "./SettingsPrimitives";
import { useTranslation } from "../i18n";
import { useBrowseStore } from "../store/browse";

export function BrowseSettingsPanel() {
  const { t } = useTranslation();
  const sourceWorkConcurrency = useBrowseStore(
    (s) => s.sourceWorkConcurrency,
  );
  const setSourceWorkConcurrency = useBrowseStore(
    (s) => s.setSourceWorkConcurrency,
  );
  const sourceRequestTimeoutSeconds = useBrowseStore(
    (s) => s.sourceRequestTimeoutSeconds,
  );
  const setSourceRequestTimeoutSeconds = useBrowseStore(
    (s) => s.setSourceRequestTimeoutSeconds,
  );
  const chapterDownloadCooldownSeconds = useBrowseStore(
    (s) => s.chapterDownloadCooldownSeconds,
  );
  const setChapterDownloadCooldownSeconds = useBrowseStore(
    (s) => s.setChapterDownloadCooldownSeconds,
  );

  return (
    <Stack gap="md">
      <SettingsSection title={t("browseSettings.group.search")}>
        <SettingsFieldRow
          label={t("browseSettings.sourceWorkConcurrency")}
          description={t("browseSettings.sourceWorkConcurrency.description")}
        >
          <NumberInput
            value={sourceWorkConcurrency}
            min={1}
            max={10}
            step={1}
            clampBehavior="strict"
            onChange={(value) => {
              if (typeof value === "number") {
                setSourceWorkConcurrency(value);
              }
            }}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("browseSettings.sourceRequestTimeout")}
          description={t("browseSettings.sourceRequestTimeout.description")}
        >
          <NumberInput
            value={sourceRequestTimeoutSeconds}
            min={5}
            max={120}
            step={5}
            clampBehavior="strict"
            suffix={` ${t("common.seconds")}`}
            onChange={(value) => {
              if (typeof value === "number") {
                setSourceRequestTimeoutSeconds(value);
              }
            }}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t("browseSettings.group.downloads")}>
        <SettingsFieldRow
          label={t("browseSettings.chapterDownloadCooldown")}
          description={t("browseSettings.chapterDownloadCooldown.description")}
        >
          <NumberInput
            value={chapterDownloadCooldownSeconds}
            min={0}
            max={60}
            step={1}
            clampBehavior="strict"
            suffix={` ${t("common.seconds")}`}
            onChange={(value) => {
              if (typeof value === "number") {
                setChapterDownloadCooldownSeconds(value);
              }
            }}
          />
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}

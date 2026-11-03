import { useState } from "react";
import { NumberInput, Select, Stack, Textarea } from "@mantine/core";
import { ConsoleChip } from "../ConsolePrimitives";
import {
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
  SettingsWideField,
} from "../SettingsPrimitives";
import { TextButton } from "../TextButton";
import { useConfirm } from "../ui/ConfirmDialog";
import { describeError } from "../../lib/errors";
import { enqueueMainTask } from "../../lib/tasks/main-tasks";
import { clearWebViewCache } from "../../lib/webview-cache";
import {
  formatDateTimeForLocale,
  useTranslation,
  type AppLocale,
  type TranslationKey,
} from "../../i18n";
import { useBrowseStore } from "../../store/browse";
import { LOG_LEVELS, type LogLevel, useLoggingStore } from "../../store/logging";
import { useUserAgentStore } from "../../store/user-agent";
import type { SettingsBusyProps } from "./settings-busy";
import {
  showSettingsLoadingToast,
  showSettingsToast,
  updateSettingsToast,
} from "./settings-toast";
import {
  canInstallUpdate,
  updateStatusLabel,
  useAppUpdates,
} from "./use-app-updates";

const LOG_LEVEL_LABEL_KEYS: Record<LogLevel, TranslationKey> = {
  trace: "settings.about.logLevel.trace",
  debug: "settings.about.logLevel.debug",
  info: "settings.about.logLevel.info",
  warn: "settings.about.logLevel.warn",
  error: "settings.about.logLevel.error",
  off: "settings.about.logLevel.off",
};

export function logLevelLabelKey(level: LogLevel): TranslationKey {
  return LOG_LEVEL_LABEL_KEYS[level];
}

function formatOptionalBuildTime(
  locale: AppLocale,
  buildTime: string | null | undefined,
): string {
  if (!buildTime) return "";
  const timestamp = Date.parse(buildTime);
  return Number.isFinite(timestamp)
    ? formatDateTimeForLocale(locale, timestamp)
    : buildTime;
}

export function DeveloperSection({ isBusy, onBusyChange }: SettingsBusyProps) {
  const { locale, t } = useTranslation();
  const confirm = useConfirm();
  const updates = useAppUpdates("dev");
  const logLevel = useLoggingStore((state) => state.logLevel);
  const setLogLevel = useLoggingStore((state) => state.setLogLevel);
  const userAgent = useUserAgentStore((state) => state.userAgent);
  const setUserAgent = useUserAgentStore((state) => state.setUserAgent);
  const resetUserAgent = useUserAgentStore((state) => state.resetUserAgent);
  const [userAgentInput, setUserAgentInput] = useState(userAgent);
  const sourceRequestTimeoutSeconds = useBrowseStore(
    (s) => s.sourceRequestTimeoutSeconds,
  );
  const setSourceRequestTimeoutSeconds = useBrowseStore(
    (s) => s.setSourceRequestTimeoutSeconds,
  );
  const buildTime = formatOptionalBuildTime(locale, updates.buildInfo?.buildTime);

  async function handleClearWebViewCache(): Promise<void> {
    const kind = "maintenance.clearWebViewCache";
    const title = t("settings.data.webViewCache.button");
    const confirmed = await confirm({
      title,
      message: t("settings.data.webViewCache.warning"),
      confirmLabel: title,
    });
    if (!confirmed) return;
    onBusyChange(kind);
    showSettingsLoadingToast(
      kind,
      title,
      t("settings.data.webViewCache.busy"),
    );
    try {
      await enqueueMainTask({
        kind,
        title,
        run: async () => {
          await clearWebViewCache();
          updateSettingsToast(
            kind,
            "ok",
            title,
            t("settings.data.webViewCache.done"),
          );
        },
      }).promise;
    } catch (error) {
      updateSettingsToast(
        kind,
        "danger",
        title,
        t("settings.data.maintenanceFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      onBusyChange(null);
    }
  }

  return (
    <Stack gap="md">
      <SettingsSection title={t("settings.about.build.title")}>
        <SettingsFieldRow
          label={t("settings.about.buildTime.label")}
          description={t("settings.about.buildTime.description")}
        >
          <ConsoleChip>{buildTime}</ConsoleChip>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.platform.label")}
          description={t("settings.about.platform.description")}
        >
          <ConsoleChip>{updates.buildInfo?.platform ?? ""}</ConsoleChip>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.buildChannel.label")}
          description={t("settings.about.buildChannel.description")}
        >
          <ConsoleChip>{updates.buildInfo?.buildChannel ?? ""}</ConsoleChip>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.devUpdate.label")}
          description={t("settings.about.devUpdate.description")}
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
      </SettingsSection>

      <SettingsSection title={t("settings.about.diagnostics.title")}>
        <SettingsFieldRow
          label={t("settings.about.logLevel.label")}
          description={t("settings.about.logLevel.description")}
        >
          <Select
            allowDeselect={false}
            data={LOG_LEVELS.map((level) => ({
              value: level,
              label: t(LOG_LEVEL_LABEL_KEYS[level]),
            }))}
            value={logLevel}
            onChange={setLogLevel}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.data.webViewCache.label")}
          description={t("settings.data.webViewCache.description")}
        >
          <TextButton
            disabled={isBusy}
            loading={isBusy}
            variant="default"
            onClick={() => {
              void handleClearWebViewCache();
            }}
          >
            {t("settings.data.webViewCache.button")}
          </TextButton>
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t("settings.data.network.title")}>
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
        <SettingsFieldRow
          label={t("settings.data.userAgent.label")}
          description={t("settings.data.userAgent.description")}
          layout="stacked"
        >
          <SettingsWideField>
            <Stack gap="sm">
              <Textarea
                aria-label={t("settings.data.userAgent.label")}
                value={userAgentInput}
                autosize
                minRows={3}
                onChange={(event) => setUserAgentInput(event.currentTarget.value)}
              />
              <SettingsInlineControls>
                <TextButton
                  tone="accent"
                  onClick={() => {
                    setUserAgent(userAgentInput);
                    showSettingsToast("ok", t("settings.toast.saved"));
                  }}
                >
                  {t("common.save")}
                </TextButton>
                <TextButton
                  variant="default"
                  onClick={() => {
                    setUserAgentInput(resetUserAgent());
                    showSettingsToast("ok", t("settings.toast.reset"));
                  }}
                >
                  {t("common.reset")}
                </TextButton>
              </SettingsInlineControls>
            </Stack>
          </SettingsWideField>
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}

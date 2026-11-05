import { useState } from "react";
import { NumberInput, Select, Stack, Textarea } from "@mantine/core";
import { ConsoleChip } from "../ConsolePrimitives";
import {
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
  SettingsWideField,
} from "../SettingsPrimitives";
import { IconButton } from "../IconButton";
import { useConfirm } from "../ui/ConfirmDialog";
import { DownloadIcon, RefreshIcon, ResetIcon, SaveIcon, TrashIcon } from "../ui/icons";
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

/** Source WebViews read the User-Agent when they start, so a change applies after a restart. */
const USER_AGENT_AT_STARTUP = useUserAgentStore.getState().userAgent;

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
          {buildTime ? <ConsoleChip>{buildTime}</ConsoleChip> : null}
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.platform.label")}
          description={t("settings.about.platform.description")}
        >
          {updates.buildInfo?.platform ? <ConsoleChip>{updates.buildInfo.platform}</ConsoleChip> : null}
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.buildChannel.label")}
          description={t("settings.about.buildChannel.description")}
        >
          {updates.buildInfo ? (
            <ConsoleChip>
              {updates.buildInfo.buildChannel ?? t("settings.about.version.localBuild")}
            </ConsoleChip>
          ) : null}
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.devUpdate.label")}
          description={t("settings.about.devUpdate.description")}
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
          <IconButton
            label={t("settings.data.webViewCache.button")}
            size="lg"
            tone="danger"
            disabled={isBusy}
            loading={isBusy}
            onClick={() => {
              void handleClearWebViewCache();
            }}
          >
            <TrashIcon />
          </IconButton>
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t("settings.data.network.title")}>
        <SettingsFieldRow
          label={t("browseSettings.sourceRequestTimeout")}
          description={t("browseSettings.sourceRequestTimeout.description")}
        >
          <NumberInput
            className="norea-settings-compact-field"
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
          status={
            userAgent === USER_AGENT_AT_STARTUP
              ? null
              : t("settings.data.userAgent.restartRequired")
          }
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
                <IconButton
                  label={t("settings.data.userAgent.save")}
                  size="lg"
                  onClick={() => {
                    setUserAgent(userAgentInput);
                    showSettingsToast(
                      "ok",
                      t("settings.toast.saved"),
                      t("settings.data.userAgent.restartRequired"),
                    );
                  }}
                >
                  <SaveIcon />
                </IconButton>
                <IconButton
                  label={t("settings.data.userAgent.reset")}
                  size="lg"
                  onClick={() => {
                    setUserAgentInput(resetUserAgent());
                    showSettingsToast(
                      "ok",
                      t("settings.toast.reset"),
                      t("settings.data.userAgent.restartRequired"),
                    );
                  }}
                >
                  <ResetIcon />
                </IconButton>
              </SettingsInlineControls>
            </Stack>
          </SettingsWideField>
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}

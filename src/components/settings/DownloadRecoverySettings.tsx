import { NumberInput, Select, Switch, Text } from "@mantine/core";
import { useTranslation } from "../../i18n";
import { canResetSourceSiteData, canRotateBrowserFingerprint } from "../../lib/site-browser/session";
import { useDownloadRecoveryStore } from "../../store/download-recovery";
import { SettingsFieldRow, SettingsSection } from "../SettingsPrimitives";

export function DownloadRecoverySettings({ isBusy = false }: { isBusy?: boolean } = {}) {
  const { t } = useTranslation();
  const policy = useDownloadRecoveryStore();
  const resetSupported = canResetSourceSiteData();
  const fingerprintSupported = canRotateBrowserFingerprint();
  const pause = { value: "pause", label: t("settings.downloads.recovery.action.pause") };
  const retry = { value: "retry", label: t("settings.downloads.recovery.action.retry") };

  return (
    <SettingsSection
      title={t("settings.downloads.recovery.title")}
      description={t("settings.downloads.recovery.description")}
    >
      <Text c="dimmed" size="sm">{t("settings.downloads.recovery.appliesHint")}</Text>
      <SettingsFieldRow
        label={t("settings.downloads.recovery.forbidden.label")}
        description={t("settings.downloads.recovery.forbidden.description")}
        status={resetSupported ? null : t("settings.downloads.recovery.resetUnsupported")}
      >
        <Select
          aria-label={t("settings.downloads.recovery.forbidden.label")}
          allowDeselect={false}
          disabled={isBusy}
          data={[pause, retry, {
            value: "resetSite", label: t("settings.downloads.recovery.action.resetSite"), disabled: !resetSupported,
          }]}
          value={policy.forbiddenAction}
          onChange={(value) => {
            if (!isBusy && (value === "pause" || value === "retry" || (value === "resetSite" && resetSupported))) {
              policy.setPolicy({ forbiddenAction: value });
            }
          }}
        />
      </SettingsFieldRow>
      <Text c="dimmed" size="sm">{t("settings.downloads.recovery.resetHint")}</Text>
      <SettingsFieldRow
        label={t("settings.downloads.recovery.transient.label")}
        description={t("settings.downloads.recovery.transient.description")}
      >
        <Select
          aria-label={t("settings.downloads.recovery.transient.label")}
          allowDeselect={false}
          disabled={isBusy}
          data={[pause, retry, { value: "nextProfile", label: t("settings.downloads.recovery.action.nextProfile") }]}
          value={policy.transientAction}
          onChange={(value) => {
            if (!isBusy && (value === "pause" || value === "retry" || value === "nextProfile")) {
              policy.setPolicy({ transientAction: value });
            }
          }}
        />
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t("settings.downloads.recovery.rateLimit.label")}
        description={t("settings.downloads.recovery.rateLimit.description")}
      >
        <Select
          aria-label={t("settings.downloads.recovery.rateLimit.label")}
          allowDeselect={false}
          disabled={isBusy}
          data={[pause, retry]}
          value={policy.rateLimitAction}
          onChange={(value) => {
            if (!isBusy && (value === "pause" || value === "retry")) policy.setPolicy({ rateLimitAction: value });
          }}
        />
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t("settings.downloads.recovery.notFound.label")}
        description={t("settings.downloads.recovery.notFound.description")}
      >
        <Select
          aria-label={t("settings.downloads.recovery.notFound.label")}
          allowDeselect={false}
          disabled={isBusy}
          data={[{ value: "skip", label: t("settings.downloads.recovery.action.skip") }, pause]}
          value={policy.notFoundAction}
          onChange={(value) => {
            if (!isBusy && (value === "skip" || value === "pause")) policy.setPolicy({ notFoundAction: value });
          }}
        />
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t("settings.downloads.recovery.maxRetries.label")}
        description={t("settings.downloads.recovery.maxRetries.description")}
      >
        <NumberInput
          aria-label={t("settings.downloads.recovery.maxRetries.label")}
          value={policy.maxRetries}
          min={0}
          max={5}
          allowDecimal={false}
          allowNegative={false}
          clampBehavior="strict"
          disabled={isBusy}
          onChange={(value) => {
            if (!isBusy && typeof value === "number") policy.setPolicy({ maxRetries: value });
          }}
        />
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t("settings.downloads.recovery.retryDelay.label")}
        description={t("settings.downloads.recovery.retryDelay.description")}
      >
        <NumberInput
          aria-label={t("settings.downloads.recovery.retryDelay.label")}
          value={policy.retryDelaySeconds}
          min={5}
          max={3_600}
          allowDecimal={false}
          allowNegative={false}
          clampBehavior="strict"
          suffix={` ${t("common.seconds")}`}
          disabled={isBusy}
          onChange={(value) => {
            if (!isBusy && typeof value === "number") policy.setPolicy({ retryDelaySeconds: value });
          }}
        />
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t("settings.downloads.recovery.maxProfileChanges.label")}
        description={t("settings.downloads.recovery.maxProfileChanges.description")}
      >
        <NumberInput
          aria-label={t("settings.downloads.recovery.maxProfileChanges.label")}
          value={policy.maxProfileChanges}
          min={0}
          max={3}
          allowDecimal={false}
          allowNegative={false}
          clampBehavior="strict"
          disabled={isBusy}
          onChange={(value) => {
            if (!isBusy && typeof value === "number") policy.setPolicy({ maxProfileChanges: value });
          }}
        />
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t("settings.downloads.recovery.fingerprint.label")}
        description={t("settings.downloads.recovery.fingerprint.description")}
        status={fingerprintSupported ? null : t("settings.downloads.recovery.fingerprintUnsupported")}
      >
        <Switch
          aria-label={t("settings.downloads.recovery.fingerprint.label")}
          checked={policy.rotateFingerprintOnVpnChange}
          disabled={isBusy || (!fingerprintSupported && !policy.rotateFingerprintOnVpnChange)}
          onChange={(event) => {
            if (!isBusy && (fingerprintSupported || !event.currentTarget.checked)) {
              policy.setPolicy({ rotateFingerprintOnVpnChange: event.currentTarget.checked });
            }
          }}
        />
      </SettingsFieldRow>
      <Text c="dimmed" size="sm">{t("settings.downloads.recovery.fingerprint.hint")}</Text>
    </SettingsSection>
  );
}

import { useEffect, useState } from "react";
import { useConfirm } from "../ui/ConfirmDialog";
import { describeError } from "../../lib/errors";
import {
  checkDevUpdate,
  checkOfficialUpdate,
  getBuildInfo,
  installUpdate,
  type BuildInfo,
  type UpdateCandidate,
  type UpdateChannel,
} from "../../lib/update";
import { useTranslation, type TranslationKey } from "../../i18n";
import {
  showSettingsLoadingToast,
  showSettingsToast,
  updateSettingsToast,
} from "./settings-toast";

type UpdateBusy = `${UpdateChannel}:check` | `${UpdateChannel}:install`;
type Translate = (
  key: TranslationKey,
  values?: Record<string, string | number>,
) => string;

export function updateStatusLabel(
  t: Translate,
  candidate: UpdateCandidate | null,
): string {
  if (!candidate) return "";
  switch (candidate.status) {
    case "newer":
      return t("settings.about.update.status.newer");
    case "current":
      return t("settings.about.update.status.current");
    case "unknown":
      return t("settings.about.update.status.unknown");
  }
}

function updateStatusMessage(t: Translate, candidate: UpdateCandidate): string {
  switch (candidate.status) {
    case "newer":
      return t("settings.about.update.available", {
        name: candidate.displayName,
      });
    case "current":
      return t("settings.about.update.current", {
        name: candidate.displayName,
      });
    case "unknown":
      return t("settings.about.update.unknown", {
        name: candidate.displayName,
      });
  }
}

/** The version this build reports: the CI release version, else the app version. */
export function buildVersionLabel(buildInfo: BuildInfo): string {
  return `v${buildInfo.buildVersion ?? buildInfo.appVersion}`;
}

/** Channel and short commit for builds that are not official releases, or null for releases. */
export function buildIdentityLabel(t: Translate, buildInfo: BuildInfo): string | null {
  if (buildInfo.buildChannel === "release") return null;
  const channel = buildInfo.buildChannel === null
    ? t("settings.about.version.localBuild")
    : buildInfo.buildChannel === "dev"
      ? t("settings.about.version.devBuild")
      : buildInfo.buildChannel;
  return buildInfo.gitSha ? `${channel} · ${buildInfo.gitSha.slice(0, 7)}` : channel;
}

export function canInstallUpdate(candidate: UpdateCandidate | null): boolean {
  return Boolean(candidate?.integrity && candidate.status !== "current");
}

/** Build metadata plus manual update checks for one release channel. */
export function useAppUpdates(channel: UpdateChannel) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [candidate, setCandidate] = useState<UpdateCandidate | null>(null);
  const [updateBusy, setUpdateBusy] = useState<UpdateBusy | null>(null);

  useEffect(() => {
    let cancelled = false;

    getBuildInfo()
      .then((info) => {
        if (!cancelled) setBuildInfo(info);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          showSettingsToast(
            "danger",
            t("settings.about.build.title"),
            t("settings.about.buildInfoFailed", {
              error: describeError(error),
            }),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  async function checkUpdate(): Promise<void> {
    if (!buildInfo) return;

    setUpdateBusy(`${channel}:check` as UpdateBusy);
    const toastId = `settings:update:${channel}:check`;
    const title = t(
      channel === "official"
        ? "settings.about.officialUpdate.label"
        : "settings.about.devUpdate.label",
    );
    showSettingsLoadingToast(
      toastId,
      title,
      t(
        channel === "official"
          ? "settings.about.update.checkingOfficial"
          : "settings.about.update.checkingDev",
      ),
    );
    try {
      const next =
        channel === "official"
          ? await checkOfficialUpdate(buildInfo)
          : await checkDevUpdate(buildInfo);
      setCandidate(next);
      updateSettingsToast(toastId, "ok", title, updateStatusMessage(t, next));
    } catch (error) {
      updateSettingsToast(
        toastId,
        "danger",
        title,
        t("settings.about.update.checkFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setUpdateBusy(null);
    }
  }

  async function installCandidate(): Promise<void> {
    if (!candidate || !canInstallUpdate(candidate)) return;
    const confirmed = await confirm({
      title: t("settings.about.update.install"),
      message: t("settings.about.update.installConfirm", {
        name: candidate.assetName,
      }),
      confirmLabel: t("settings.about.update.install"),
    });
    if (!confirmed) return;

    setUpdateBusy(`${candidate.channel}:install` as UpdateBusy);
    const toastId = `settings:update:${candidate.channel}:install`;
    const title = t("settings.about.update.install");
    showSettingsLoadingToast(
      toastId,
      title,
      t("settings.about.update.installing", {
        name: candidate.assetName,
      }),
    );
    try {
      const path = await installUpdate(candidate, buildInfo);
      updateSettingsToast(
        toastId,
        "ok",
        title,
        t("settings.about.update.installerOpened", { path }),
      );
    } catch (error) {
      updateSettingsToast(
        toastId,
        "danger",
        title,
        t("settings.about.update.installFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setUpdateBusy(null);
    }
  }

  return {
    buildInfo,
    candidate,
    checking: updateBusy === `${channel}:check`,
    installing: updateBusy === `${channel}:install`,
    busy: updateBusy !== null,
    checkUpdate,
    installCandidate,
  };
}

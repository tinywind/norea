import { useEffect, useState } from "react";
import { NumberInput, Select, Stack, Switch, Text } from "@mantine/core";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ChapterCleanupPanel } from "../ChapterCleanupPanel";
import { useConfirm } from "../ui/ConfirmDialog";
import { StorageRecoveryBanner } from "../runtime/StorageRecovery";
import {
  SettingsAdvancedGroup,
  SettingsFieldRow,
  SettingsSection,
  SettingsWideField,
} from "../SettingsPrimitives";
import { TextButton } from "../TextButton";
import {
  getChapterMediaStorageRoot,
  selectChapterMediaStorageRoot,
} from "../../lib/chapter-media-storage";
import { restartChapterContentStorageMirrorSweep } from "../../lib/chapter-content-storage";
import { describeError } from "../../lib/errors";
import { isAndroidRuntime } from "../../lib/tauri-runtime";
import { useTranslation } from "../../i18n";
import { useBrowseStore } from "../../store/browse";
import { useContentSyncStore } from "../../store/content-sync";
import {
  DEFAULT_KEEP_AHEAD_CHOICES,
  FINISHED_CHAPTER_KEEP_CHOICES,
  useDownloadGoalSettingsStore,
} from "../../store/download-goals";
import { showSettingsToast } from "./settings-toast";

export const CHAPTER_MEDIA_STORAGE_ROOT_QUERY_KEY = [
  "settings",
  "chapter-media-storage-root",
] as const;

export function reconcileChapterStorage(queryClient: QueryClient): void {
  restartChapterContentStorageMirrorSweep({
    onComplete: () => {
      void queryClient.invalidateQueries({ queryKey: ["chapter"] });
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
    },
  });
}

/**
 * Lets the user pick the storage folder and refreshes what depends on it.
 * Resolves the chosen root, or null when the picker was dismissed.
 */
export async function chooseStorageFolder(queryClient: QueryClient): Promise<string | null> {
  const root = await selectChapterMediaStorageRoot();
  if (!root) return null;
  queryClient.setQueryData(CHAPTER_MEDIA_STORAGE_ROOT_QUERY_KEY, root);
  reconcileChapterStorage(queryClient);
  void queryClient.invalidateQueries({ queryKey: ["novel"] });
  void queryClient.invalidateQueries({ queryKey: ["category"] });
  return root;
}

function MediaStorageSettings({ isBusy }: { isBusy: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mediaStorageRoot, setMediaStorageRoot] = useState<string | null>(null);
  const [mediaStorageBusy, setMediaStorageBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void getChapterMediaStorageRoot()
      .then((root) => {
        setMediaStorageRoot(root);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        setLoadError(
          t("settings.data.mediaStorage.loadFailed", {
            error: describeError(error),
          }),
        );
      });
  }, [t]);

  async function chooseMediaStorageRoot(): Promise<void> {
    setMediaStorageBusy(true);
    try {
      const root = await chooseStorageFolder(queryClient);
      if (root) {
        setMediaStorageRoot(root);
        setLoadError(null);
        showSettingsToast("ok", t("settings.toast.saved"));
      }
    } catch (error) {
      showSettingsToast(
        "danger",
        t("settings.data.mediaStorage.selectFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setMediaStorageBusy(false);
    }
  }

  return (
    <SettingsSection title={t("settings.data.mediaStorage.title")}>
      <StorageRecoveryBanner />
      <SettingsFieldRow
        label={t("settings.data.mediaStorage.folder.label")}
        description={
          isAndroidRuntime()
            ? t("settings.data.mediaStorage.folder.androidDefaultDescription")
            : t("settings.data.mediaStorage.folder.description")
        }
        error={loadError}
        layout="stacked"
      >
        <SettingsWideField>
          <Text className="norea-settings-path-value">
            {mediaStorageRoot ?? t("settings.data.mediaStorage.folder.empty")}
          </Text>
        </SettingsWideField>
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t("settings.data.mediaStorage.change.label")}
        description={
          isAndroidRuntime()
            ? t("settings.data.mediaStorage.change.androidDefaultDescription")
            : t("settings.data.mediaStorage.change.description")
        }
      >
        <TextButton
          loading={mediaStorageBusy}
          disabled={mediaStorageBusy || isBusy}
          onClick={() => {
            void chooseMediaStorageRoot();
          }}
        >
          {isAndroidRuntime()
            ? t("storageSetup.selectExternalFolder")
            : t("storageSetup.selectFolder")}
        </TextButton>
      </SettingsFieldRow>
    </SettingsSection>
  );
}

function FinishedChapterCleanupRow() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const keep = useDownloadGoalSettingsStore((state) => state.finishedChapterKeep);
  const withoutServer = useDownloadGoalSettingsStore((state) => state.finishedCleanupWithoutServer);
  const hasServer = useContentSyncStore((state) => Boolean(state.serverUrl));

  async function choose(next: number): Promise<void> {
    const { setFinishedChapterCleanup } = useDownloadGoalSettingsStore.getState();
    if (next === 0 || hasServer || withoutServer) {
      setFinishedChapterCleanup(next, withoutServer);
      return;
    }
    const accepted = await confirm({
      title: t("settings.downloads.finishedCleanup.noServer.title"),
      message: t("settings.downloads.finishedCleanup.noServer.message"),
      confirmLabel: t("settings.downloads.finishedCleanup.noServer.confirm"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (accepted) setFinishedChapterCleanup(next, true);
  }

  return (
    <SettingsFieldRow
      label={t("settings.downloads.finishedCleanup.label")}
      description={t(hasServer
        ? "settings.downloads.finishedCleanup.serverDescription"
        : "settings.downloads.finishedCleanup.description")}
    >
      <Select
        allowDeselect={false}
        data={FINISHED_CHAPTER_KEEP_CHOICES.map((count) => ({
          value: String(count),
          label: count === 0
            ? t("settings.downloads.finishedCleanup.off")
            : t("settings.downloads.finishedCleanup.keep", { count }),
        }))}
        value={String(keep)}
        onChange={(value) => {
          if (value !== null) void choose(Number(value));
        }}
      />
    </SettingsFieldRow>
  );
}

export function DownloadsSection({ isBusy }: { isBusy: boolean }) {
  const { t } = useTranslation();
  const [cleanupOpened, setCleanupOpened] = useState(false);
  const sourceWorkConcurrency = useBrowseStore((s) => s.sourceWorkConcurrency);
  const setSourceWorkConcurrency = useBrowseStore(
    (s) => s.setSourceWorkConcurrency,
  );
  const chapterDownloadCooldownSeconds = useBrowseStore(
    (s) => s.chapterDownloadCooldownSeconds,
  );
  const setChapterDownloadCooldownSeconds = useBrowseStore(
    (s) => s.setChapterDownloadCooldownSeconds,
  );
  const goalSettings = useDownloadGoalSettingsStore();

  return (
    <Stack gap="md">
      <MediaStorageSettings isBusy={isBusy} />

      <SettingsSection title={t("browseSettings.group.downloads")}>
        <SettingsFieldRow
          label={t("settings.downloads.keepAhead.label")}
          description={t("settings.downloads.keepAhead.description")}
        >
          <Select
            allowDeselect={false}
            data={DEFAULT_KEEP_AHEAD_CHOICES.map((count) => ({
              value: String(count),
              label: count === 0
                ? t("settings.downloads.keepAhead.off")
                : t("settings.downloads.keepAhead.count", { count }),
            }))}
            value={String(goalSettings.defaultKeepAhead)}
            onChange={(value) => {
              if (value !== null) goalSettings.setDefaultKeepAhead(Number(value));
            }}
          />
        </SettingsFieldRow>
        {isAndroidRuntime() ? (
          <SettingsFieldRow
            label={t("settings.downloads.mobileData.label")}
            description={t("settings.downloads.mobileData.description")}
          >
            <Switch
              checked={goalSettings.automaticOnMobileData}
              onChange={(event) =>
                goalSettings.setAutomaticOnMobileData(event.currentTarget.checked)
              }
            />
          </SettingsFieldRow>
        ) : null}
        <FinishedChapterCleanupRow />
        <SettingsFieldRow
          label={t("settings.data.downloadedContent.label")}
          description={t("settings.data.downloadedContent.description")}
        >
          <TextButton
            disabled={isBusy}
            loading={isBusy}
            variant="default"
            tone="danger"
            onClick={() => setCleanupOpened(true)}
          >
            {t("settings.data.downloadedContent.button")}
          </TextButton>
        </SettingsFieldRow>
        <SettingsAdvancedGroup>
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
        </SettingsAdvancedGroup>
      </SettingsSection>
      <ChapterCleanupPanel
        opened={cleanupOpened}
        onClose={() => setCleanupOpened(false)}
      />
    </Stack>
  );
}

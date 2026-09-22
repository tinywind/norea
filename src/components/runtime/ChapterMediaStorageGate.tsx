import { Button, Paper, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState, type ReactNode } from "react";
import { translate } from "../../i18n";
import {
  getChapterMediaStorageRoot,
  selectChapterMediaStorageRoot,
} from "../../lib/chapter-media-storage";
import { describeError } from "../../lib/errors";
import { pluginManager } from "../../lib/plugins/manager";
import { isAndroidRuntime, isTauriRuntime } from "../../lib/tauri-runtime";
import { useAppearanceStore } from "../../store/appearance";

export function ChapterMediaStorageGate({ children }: { children: ReactNode }) {
  const appLocale = useAppearanceStore((state) => state.appLocale);
  const [checking, setChecking] = useState(isTauriRuntime());
  const [storageReady, setStorageReady] = useState(!isTauriRuntime());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let cancelled = false;
    void getChapterMediaStorageRoot()
      .then((root) => {
        if (cancelled) return;
        if (isAndroidRuntime()) {
          setStorageReady(root?.trim().startsWith("content://") === true);
          return;
        }
        setStorageReady(root !== null && root.trim() !== "");
      })
      .catch((unknownError: unknown) => {
        if (cancelled) return;
        setError(describeError(unknownError));
        setStorageReady(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || !isTauriRuntime()) return;

    void pluginManager.loadInstalledFromDb().catch((unknownError: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(
        "[bootstrap] failed to rehydrate installed plugins",
        unknownError,
      );
    });
  }, [storageReady]);

  async function chooseStorageRoot(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const root = await selectChapterMediaStorageRoot();
      if (root) {
        setStorageReady(true);
      }
    } catch (unknownError) {
      setError(describeError(unknownError));
    } finally {
      setBusy(false);
      setChecking(false);
    }
  }

  if (checking) {
    return (
      <div className="norea-storage-setup">
        <Paper className="norea-storage-setup-card" withBorder>
          <Text>{translate(appLocale, "storageSetup.checking")}</Text>
        </Paper>
      </div>
    );
  }

  if (!storageReady) {
    return (
      <div className="norea-storage-setup">
        <Paper className="norea-storage-setup-card" withBorder>
          <Stack gap="md">
            <Stack gap="xs">
              <Title order={1} className="norea-storage-setup-title">
                {translate(appLocale, "storageSetup.title")}
              </Title>
              <Text className="norea-storage-setup-copy">
                {translate(
                  appLocale,
                  isAndroidRuntime()
                    ? "storageSetup.androidDefaultDescription"
                    : "storageSetup.description",
                )}
              </Text>
            </Stack>
            {error ? (
              <Text className="norea-storage-setup-error" role="alert">
                {translate(appLocale, "storageSetup.failed", { error })}
              </Text>
            ) : null}
            <Button
              loading={busy}
              onClick={() => {
                void chooseStorageRoot();
              }}
            >
              {translate(
                appLocale,
                isAndroidRuntime()
                  ? "storageSetup.useAppStorage"
                  : "storageSetup.selectFolder",
              )}
            </Button>
          </Stack>
        </Paper>
      </div>
    );
  }

  return children;
}

import { Alert, Button, Group, Radio, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { setNovelCompletedOverride } from "../../db/queries/novel-override";
import { useTranslation } from "../../i18n";
import { pushWorkOverridesNow } from "../../lib/content-sync/work-overrides";
import { describeError } from "../../lib/errors";
import { completedOverrideOf } from "../../lib/work-metadata/override";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { novelKey, novelStatusLabel } from "./novel-detail-model";

type CompletionChoice = "source" | "completed" | "ongoing";

const choiceOf = (completedOverride: boolean | null): CompletionChoice =>
  completedOverride === null ? "source" : completedOverride ? "completed" : "ongoing";

interface NovelCompletionEditorProps {
  active: boolean;
  completedOverride: boolean | null;
  novelId: number;
  novelName: string;
  onClose: () => void;
  opened: boolean;
  /** The source's own status text, shown beside the choice that follows it. */
  sourceStatus: string | null;
}

/** The sheet that sets whether a work is completed, independent of what its source reports. */
export function NovelCompletionEditor({
  active, completedOverride, novelId, novelName, onClose, opened, sourceStatus,
}: NovelCompletionEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<CompletionChoice>(choiceOf(completedOverride));
  const save = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (next: CompletionChoice) =>
      setNovelCompletedOverride(novelId, next === "source" ? null : next === "completed"),
    onSuccess: (override) => {
      queryClient.setQueryData<NovelDetailRecord | null>(novelKey(novelId), (novel) =>
        novel ? { ...novel, completedOverride: completedOverrideOf(override) } : novel);
      void pushWorkOverridesNow().catch((error: unknown) => {
        console.warn("[content-sync] could not send the work override:", error);
      });
      onClose();
      notifications.show({ color: "ok", message: t("novel.completion.saved") });
    },
  });
  const visible = active && opened;
  const resetSave = save.reset;

  useEffect(() => {
    if (!visible) return;
    setChoice(choiceOf(completedOverride));
    resetSave();
  }, [completedOverride, resetSave, visible]);

  const close = () => {
    if (!save.isPending) onClose();
  };
  const sourceLabel = novelStatusLabel(sourceStatus, t);

  return (
    <ResponsiveSheet
      busy={save.isPending}
      footer={
        <Group gap="xs" justify="flex-end">
          <Button disabled={save.isPending} onClick={close} variant="default">
            {t("common.cancel")}
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate(choice)}>
            {t("common.apply")}
          </Button>
        </Group>
      }
      onClose={close}
      opened={visible}
      title={t("novel.completion.title")}
    >
      <Stack gap="md">
        <Text fw="var(--norea-weight-bold)">{novelName}</Text>
        <Text c="dimmed" size="sm">{t("novel.completion.description")}</Text>
        {save.error ? (
          <Alert color="danger" role="alert">
            {describeError(save.error)}
          </Alert>
        ) : null}
        <Radio.Group
          aria-label={t("novel.completion.title")}
          onChange={(value) => setChoice(value as CompletionChoice)}
          value={choice}
        >
          <Stack gap="sm">
            <Radio
              disabled={save.isPending}
              label={sourceLabel
                ? t("novel.completion.followSourceStatus", { status: sourceLabel })
                : t("novel.completion.followSource")}
              value="source"
            />
            <Radio disabled={save.isPending} label={t("novel.status.completed")} value="completed" />
            <Radio disabled={save.isPending} label={t("novel.status.ongoing")} value="ongoing" />
          </Stack>
        </Radio.Group>
      </Stack>
    </ResponsiveSheet>
  );
}

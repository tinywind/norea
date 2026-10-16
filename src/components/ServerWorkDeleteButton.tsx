import { Alert, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import { deleteServerWork } from "../lib/content-sync/management";
import { removeDeletedServerWorkFromQueries } from "../lib/content-sync/management-query-cache";
import type { ServerNovelSource } from "../lib/content-sync/novel-source";
import { describeError } from "../lib/errors";
import { TextButton } from "./TextButton";

interface ServerWorkDeleteButtonProps {
  source: ServerNovelSource;
  name: string;
  disabled?: boolean;
  compact?: boolean;
  onOpenChange?: (opened: boolean) => void;
  onDeleted?: () => void;
}

export function ServerWorkDeleteButton({ source, name, disabled, compact, onOpenChange, onDeleted }: ServerWorkDeleteButtonProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const changeOpen = (next: boolean) => { setOpened(next); onOpenChange?.(next); };
  const remove = useMutation({
    mutationFn: () => deleteServerWork(source),
    onSuccess: async entry => {
      await removeDeletedServerWorkFromQueries(queryClient, source, entry);
      notifications.show({ message: t("contentSync.deleteWorkDone") });
      changeOpen(false);
      onDeleted?.();
    },
  });
  const close = () => { if (!remove.isPending) changeOpen(false); };
  usePageBackNavigation(() => {
    if (!opened) return false;
    close();
    return true;
  });
  return <>
    <TextButton size="sm" tone="danger" disabled={disabled || remove.isPending}
      aria-label={`${t("contentSync.deleteWorkServer")}: ${name}`}
      onClick={() => { remove.reset(); changeOpen(true); }}>
      {t(compact ? "contentSync.deleteServer" : "contentSync.deleteWorkServer")}
    </TextButton>
    <Modal opened={opened} onClose={close} title={t("contentSync.deleteWorkServer")} centered
      closeOnClickOutside={!remove.isPending} closeOnEscape={!remove.isPending} withCloseButton={!remove.isPending}>
      <Stack>
        <Text>{t("contentSync.deleteWorkConfirm", { name })}</Text>
        <Text size="sm" c="dimmed" className="norea-server-address">{source.serverUrl}</Text>
        {remove.error ? <Alert color="red" title={t("common.actionFailed")}>{describeError(remove.error)}</Alert> : null}
        <Group justify="flex-end">
          <TextButton disabled={remove.isPending} onClick={close}>{t("common.cancel")}</TextButton>
          <TextButton tone="danger" loading={remove.isPending} onClick={() => remove.mutate()}>{t("contentSync.deleteWorkServer")}</TextButton>
        </Group>
      </Stack>
    </Modal>
  </>;
}

import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import type { ServerNovelSource } from "../lib/content-sync/novel-source";
import { confirmContentDeletion } from "../store/content-deletion";
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
  const remove = useMutation({
    mutationFn: async () => {
      onOpenChange?.(true);
      try { return await confirmContentDeletion({ kind: "server-work", source, title: name }); }
      finally { onOpenChange?.(false); }
    },
    onSuccess: changed => { if (changed) onDeleted?.(); },
  });
  return <TextButton size="sm" tone="danger" disabled={disabled || remove.isPending}
    aria-label={`${t("contentSync.deleteWorkServer")}: ${name}`} onClick={() => remove.mutate()}>
    {t(compact ? "contentSync.deleteServer" : "contentSync.deleteWorkServer")}
  </TextButton>;
}

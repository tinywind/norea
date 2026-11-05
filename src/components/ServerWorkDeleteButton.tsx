import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import type { ServerNovelSource } from "../lib/content-sync/novel-source";
import { confirmContentDeletion } from "../store/content-deletion";
import { IconButton } from "./IconButton";
import { TrashIcon } from "./ui/icons";

interface ServerWorkDeleteButtonProps {
  source: ServerNovelSource;
  name: string;
  disabled?: boolean;
  onOpenChange?: (opened: boolean) => void;
  onDeleted?: () => void;
}

export function ServerWorkDeleteButton({ source, name, disabled, onOpenChange, onDeleted }: ServerWorkDeleteButtonProps) {
  const { t } = useTranslation();
  const remove = useMutation({
    mutationFn: async () => {
      onOpenChange?.(true);
      try { return await confirmContentDeletion({ kind: "server-work", source, title: name }); }
      finally { onOpenChange?.(false); }
    },
    onSuccess: changed => { if (changed) onDeleted?.(); },
  });
  return <IconButton size="lg" tone="danger" disabled={disabled || remove.isPending}
    label={`${t("contentSync.deleteWorkServer")}: ${name}`} onClick={() => remove.mutate()}>
    <TrashIcon />
  </IconButton>;
}

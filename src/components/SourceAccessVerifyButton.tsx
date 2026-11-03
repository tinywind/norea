import { Button } from "@mantine/core";
import { useTranslation } from "../i18n";
import { useTaskSnapshot } from "../lib/tasks/hooks";
import { taskScheduler } from "../lib/tasks/scheduler";
import { openSourceAccessBrowser } from "../lib/tasks/source-access-coordinator";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";
import { useSiteBrowserStore } from "../store/site-browser";

/** Looks up the open source-access challenge of a source, if any. */
export function useSourceAccessBlocks(
  active: boolean,
): (pluginId: string) => SourceAccessBlock | undefined {
  const blocks = useTaskSnapshot(active).sourceAccessBlocks;
  return (pluginId) => blocks.find((block) => block.sourceId === pluginId);
}

interface SourceAccessVerifyButtonProps {
  block: SourceAccessBlock;
  label: string;
  sourceName: string;
}

/** Opens the source-access browser for a blocked source's challenge. */
export function SourceAccessVerifyButton({
  block,
  label,
  sourceName,
}: SourceAccessVerifyButtonProps) {
  const { t } = useTranslation();
  const browserVisible = useSiteBrowserStore((state) => state.visible);
  const verifying = block.verificationRequested || block.verificationTaskId !== undefined;

  return (
    <Button
      disabled={
        browserVisible ||
        verifying ||
        !taskScheduler.canBeginSourceAccessVerification(block.scopeKey)
      }
      loading={verifying}
      onClick={() => {
        void openSourceAccessBrowser(block, {
          sourceName,
          title:
            block.challenge.kind === "captcha"
              ? t("sourceAccess.captchaTitle")
              : t("sourceAccess.cloudflareTitle"),
        });
      }}
      size="compact-sm"
      variant="light"
    >
      {label}
    </Button>
  );
}

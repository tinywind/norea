import { Button } from "@mantine/core";
import { useTranslation } from "../i18n";
import { sourceAccessChallengeTitleKey } from "../lib/plugins/source-access";
import { useTaskSnapshot } from "../lib/tasks/hooks";
import { taskScheduler } from "../lib/tasks/scheduler";
import { openSourceAccessBrowser } from "../lib/tasks/source-access-coordinator";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";
import { useSiteBrowserStore } from "../store/site-browser";
import { IconButton } from "./IconButton";
import { SourceAccessBanner } from "./SourceAccessBanner";
import { VerifyIcon } from "./ui/icons";

/** Looks up the open source-access challenge of a source, if any. */
export function useSourceAccessBlocks(
  active: boolean,
): (pluginId: string) => SourceAccessBlock | undefined {
  const blocks = useTaskSnapshot(active).sourceAccessBlocks;
  return (pluginId) => blocks.find((block) => block.sourceId === pluginId);
}

interface SourceAccessVerifyButtonProps {
  block: SourceAccessBlock;
  /** Draws an icon button named by `label`, for rows whose label already names the source. */
  iconOnly?: boolean;
  label: string;
  sourceName: string;
}

/** Opens the source-access browser for a blocked source's challenge. */
export function SourceAccessVerifyButton({
  block,
  iconOnly = false,
  label,
  sourceName,
}: SourceAccessVerifyButtonProps) {
  const { t } = useTranslation();
  const browserVisible = useSiteBrowserStore((state) => state.visible);
  const verifying = block.verificationRequested || block.verificationTaskId !== undefined;
  const disabled =
    browserVisible ||
    verifying ||
    !taskScheduler.canBeginSourceAccessVerification(block.scopeKey);
  const verify = () => {
    void openSourceAccessBrowser(block, {
      sourceName,
      title: t(sourceAccessChallengeTitleKey(block.challenge.kind)),
    });
  };

  if (iconOnly) {
    return (
      <IconButton disabled={disabled} label={label} loading={verifying} onClick={verify} size="lg">
        <VerifyIcon />
      </IconButton>
    );
  }

  return (
    <Button
      disabled={disabled}
      loading={verifying}
      onClick={verify}
      size="compact-sm"
      variant="default"
    >
      {label}
    </Button>
  );
}

interface SourceAccessNoticeProps {
  active: boolean;
  /** Present the notice only while this is true, such as while work waits. */
  enabled?: boolean;
  sourceId: string;
  sourceName: string;
}

/**
 * Verify in place for a source whose work is held by an access check. The
 * scheduler keeps the blocked operation queued, so once the source-access
 * coordinator confirms access that same operation runs again by itself;
 * closing the site browser keeps it paused.
 */
export function SourceAccessNotice({
  active,
  enabled = true,
  sourceId,
  sourceName,
}: SourceAccessNoticeProps) {
  const block = useSourceAccessBlocks(active)(sourceId);
  if (!enabled || !block) return null;
  return <SourceAccessBanner block={block} sourceNames={[sourceName]} />;
}

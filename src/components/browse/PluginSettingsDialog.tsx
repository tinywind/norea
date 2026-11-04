import { useCallback, useRef } from "react";
import { useTranslation } from "../../i18n";
import type { Plugin } from "../../lib/plugins/types";
import { PluginSettingsEditor } from "../PluginSettingsEditor";
import { useConfirm } from "../ui/ConfirmDialog";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

interface PluginSettingsDialogProps {
  onClose: () => void;
  onSaved?: () => void;
  plugin: Plugin | null;
}

/**
 * The plugin settings form in a dialog; Android back closes it while open.
 * Closing with unsaved changes asks before discarding them.
 */
export function PluginSettingsDialog({ onClose, onSaved, plugin }: PluginSettingsDialogProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const dirtyRef = useRef(false);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const requestClose = async () => {
    if (dirtyRef.current) {
      const discard = await confirm({
        cancelLabel: t("pluginSettings.discard.keep"),
        confirmLabel: t("pluginSettings.discard.confirm"),
        danger: true,
        message: t("pluginSettings.discard.message"),
        title: t("pluginSettings.discard.title"),
      });
      if (!discard) return;
    }
    dirtyRef.current = false;
    onClose();
  };

  return (
    <ResponsiveSheet
      fullScreenOnPhone
      opened={plugin !== null}
      onClose={() => void requestClose()}
      title={t("pluginSettings.title", { name: plugin?.name ?? "" })}
    >
      {plugin ? (
        <PluginSettingsEditor
          key={plugin.id}
          plugin={plugin}
          onCancel={() => void requestClose()}
          onDirtyChange={handleDirtyChange}
          onSaved={() => {
            dirtyRef.current = false;
            onClose();
            onSaved?.();
          }}
        />
      ) : null}
    </ResponsiveSheet>
  );
}

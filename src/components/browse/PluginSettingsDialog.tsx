import { Modal } from "@mantine/core";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import type { Plugin } from "../../lib/plugins/types";
import { PluginSettingsEditor } from "../PluginSettingsEditor";

interface PluginSettingsDialogProps {
  onClose: () => void;
  onSaved?: () => void;
  plugin: Plugin | null;
}

/** The plugin settings form in a dialog; Android back closes it while open. */
export function PluginSettingsDialog({ onClose, onSaved, plugin }: PluginSettingsDialogProps) {
  const { t } = useTranslation();
  useOverlayBackNavigation(plugin !== null, onClose);

  return (
    <Modal
      opened={plugin !== null}
      onClose={onClose}
      size="lg"
      title={t("pluginSettings.title", { name: plugin?.name ?? "" })}
    >
      {plugin ? (
        <PluginSettingsEditor
          key={plugin.id}
          plugin={plugin}
          onSaved={() => {
            onClose();
            onSaved?.();
          }}
        />
      ) : null}
    </Modal>
  );
}

import { Loader, Text } from "@mantine/core";
import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";

export function StartupSplash() {
  const appLocale = useAppearanceStore((state) => state.appLocale);

  return (
    <div className="norea-storage-setup">
      <div aria-live="polite" className="norea-startup-splash" role="status">
        <img
          alt=""
          aria-hidden="true"
          className="norea-startup-splash-icon"
          src="/app-icon.svg"
        />
        <Text className="norea-startup-splash-copy">
          {translate(appLocale, "startup.starting")}
        </Text>
        <Loader aria-hidden="true" size="sm" />
      </div>
    </div>
  );
}

import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { useNetworkStore } from "../network";
import { taskScheduler } from "./scheduler";

export function initializeTaskNetworkState(): void {
  let previous = useNetworkStore.getState();
  const update = () => {
    const status = useNetworkStore.getState();
    const detail = translate(useAppearanceStore.getState().appLocale, "network.waiting");
    if (previous.connectivity === "online" && status.revision !== previous.revision) {
      taskScheduler.setNetworkAvailable(false, detail);
    }
    taskScheduler.setNetworkAvailable(
      status.connectivity === "online", detail,
    );
    previous = status;
  };
  useNetworkStore.subscribe(update);
  update();
}

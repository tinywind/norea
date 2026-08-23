import type { SiteBrowserPlatformApi } from "./types";

export const webSiteBrowser: SiteBrowserPlatformApi = {
  name: "web",
  chromeMode: "react",
  boundsFor: () => null,
  currentOrigin: async () => null,
  setBounds: async () => {},
  navigate: async () => {},
  hide: async () => {},
};

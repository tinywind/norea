import type { SiteBrowserPlatformApi } from "./types";

export const webSiteBrowser: SiteBrowserPlatformApi = {
  name: "web",
  boundsFor: () => null,
  currentOrigin: async (_sourceId) => null,
  setBounds: async () => {},
  navigate: async () => {},
  hide: async () => {},
};

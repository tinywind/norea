export interface SiteBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SiteBrowserNavigateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SiteBrowserPlatformApi {
  name: "android" | "web" | "windows";
  boundsFor(node: HTMLDivElement | null): SiteBrowserBounds | null;
  currentOrigin(sourceId: string): Promise<string | null>;
  setBounds(
    bounds: SiteBrowserBounds,
    url: string | null,
    sourceId: string | null,
  ): Promise<void>;
  navigate(
    sourceId: string,
    url: string,
    options?: SiteBrowserNavigateOptions,
  ): Promise<void>;
  hide(): Promise<void>;
}

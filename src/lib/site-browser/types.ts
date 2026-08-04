export interface SiteBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SiteBrowserControlMessage {
  action: string;
  sequence?: number | null;
}

export type SiteBrowserChromeMode = "react" | "in-page";

export interface SiteBrowserNavigateOptions {
  resetHistory?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SiteBrowserPlatformApi {
  name: string;
  chromeMode: SiteBrowserChromeMode;
  boundsFor(node: HTMLDivElement | null): SiteBrowserBounds | null;
  setBounds(bounds: SiteBrowserBounds, url: string | null): Promise<void>;
  navigate(url: string, options?: SiteBrowserNavigateOptions): Promise<void>;
  hide(): Promise<void>;
  pollControlMessage(): Promise<SiteBrowserControlMessage | null>;
}

import { useState } from "react";
import type { PluginItem } from "../../lib/plugins/types";

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** The repository icon of a plugin, or its initial when there is none or it fails to load. */
export function PluginIcon({ plugin }: { plugin: Pick<PluginItem, "iconUrl" | "name"> }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const iconUrl = plugin.iconUrl.trim();
  const showImage = isHttpUrl(iconUrl) && failedUrl !== iconUrl;

  return (
    <span aria-hidden="true" className="norea-plugin-icon">
      {showImage ? (
        <img
          alt=""
          decoding="async"
          loading="lazy"
          onError={() => setFailedUrl(iconUrl)}
          src={iconUrl}
        />
      ) : (
        (plugin.name.trim()[0] ?? "?").toUpperCase()
      )}
    </span>
  );
}

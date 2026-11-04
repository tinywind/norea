import { useState } from "react";
import type { PluginItem } from "../../lib/plugins/types";

const MONOGRAM_TONES = ["accent", "info", "ok", "warn"] as const;
type MonogramTone = (typeof MONOGRAM_TONES)[number];

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Two letters for a plugin without an icon: the initials of its first two words, or the start of its only word. */
export function pluginMonogram(name: string): string {
  const words = name.trim().split(/[\s\-_.()[\]]+/u).filter(Boolean);
  const letters =
    words.length >= 2
      ? [Array.from(words[0])[0], Array.from(words[1])[0]]
      : Array.from(words[0] ?? "?").slice(0, 2);
  const [first = "?", second = ""] = letters;
  return words.length >= 2
    ? `${first}${second}`.toUpperCase()
    : `${first.toUpperCase()}${second}`;
}

/** A stable tone for a plugin name, so the same source keeps its tint across lists and launches. */
export function pluginMonogramTone(name: string): MonogramTone {
  let hash = 0;
  for (const character of name.trim()) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return MONOGRAM_TONES[hash % MONOGRAM_TONES.length];
}

/** The repository icon of a plugin, or a tinted monogram when there is none or it fails to load. */
export function PluginIcon({ plugin }: { plugin: Pick<PluginItem, "iconUrl" | "name"> }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const iconUrl = plugin.iconUrl.trim();
  const showImage = isHttpUrl(iconUrl) && failedUrl !== iconUrl;

  return showImage ? (
    <span aria-hidden="true" className="norea-plugin-icon">
      <img
        alt=""
        decoding="async"
        loading="lazy"
        onError={() => setFailedUrl(iconUrl)}
        src={iconUrl}
      />
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="norea-plugin-icon"
      data-monogram={pluginMonogramTone(plugin.name)}
    >
      {pluginMonogram(plugin.name)}
    </span>
  );
}

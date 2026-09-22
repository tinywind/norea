import { useMemo } from "react";
import {
  getEffectiveReaderAppearanceSettings,
  getEffectiveReaderGeneralSettings,
  useReaderStore,
} from "../../store/reader";

export function useReaderSettings(
  currentSourceId: string | null,
  currentNovelId: number,
) {
  const globalReaderGeneral = useReaderStore((state) => state.general);
  const globalReaderAppearance = useReaderStore((state) => state.appearance);
  const sourceReaderSettingsOverride = useReaderStore((state) =>
    currentSourceId ? state.readerSettingsBySource[currentSourceId] : undefined,
  );
  const novelReaderSettingsOverride = useReaderStore((state) =>
    currentNovelId > 0
      ? state.readerSettingsByNovel[currentNovelId]
      : undefined,
  );
  const effectiveReaderGeneral = useMemo(
    () =>
      getEffectiveReaderGeneralSettings(
        globalReaderGeneral,
        sourceReaderSettingsOverride,
        novelReaderSettingsOverride,
      ),
    [
      globalReaderGeneral,
      sourceReaderSettingsOverride,
      novelReaderSettingsOverride,
    ],
  );
  const effectiveReaderAppearance = useMemo(
    () =>
      getEffectiveReaderAppearanceSettings(
        globalReaderAppearance,
        sourceReaderSettingsOverride,
        novelReaderSettingsOverride,
      ),
    [
      globalReaderAppearance,
      sourceReaderSettingsOverride,
      novelReaderSettingsOverride,
    ],
  );

  return { effectiveReaderGeneral, effectiveReaderAppearance };
}

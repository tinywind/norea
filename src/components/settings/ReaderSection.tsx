import { Stack } from "@mantine/core";
import {
  buildReaderSettingsFields,
  useReaderSettingsEditor,
} from "../ReaderSettingsPanel";
import { SettingsAdvancedGroup, SettingsSection } from "../SettingsPrimitives";

/** Global reader defaults. Per-novel and per-source settings live in the reader. */
export function ReaderSection() {
  const editor = useReaderSettingsEditor();
  const fields = buildReaderSettingsFields(editor);
  const { t } = editor;
  const paged = editor.general.pageReader;

  return (
    <Stack gap="md">
      <SettingsSection title={t("readerSettings.reading.title")}>
        {fields.readingMode}
        {paged ? fields.pageTransition : null}
        {fields.pdfPageFit}
        {fields.htmlImagePaging}
        {fields.fullPageReader}
        {fields.keepScreenOn}
      </SettingsSection>
      <SettingsSection title={t("readerSettings.text.title")}>
        {fields.readerTheme}
        {fields.backgroundColor}
        {fields.textColor}
        {fields.textSize}
        {fields.lineHeight}
        {fields.padding}
        {fields.font}
        {fields.alignment}
        {fields.themeActions}
      </SettingsSection>
      <SettingsSection title={t("readerSettings.controls.title")}>
        {fields.controls}
      </SettingsSection>
      <SettingsSection title={t("readerSettings.automation.title")}>
        {fields.autoScroll}
      </SettingsSection>
      <SettingsSection title={t("readerSettings.indicators.title")}>
        {fields.indicators}
      </SettingsSection>
      <SettingsSection>
        <SettingsAdvancedGroup>{fields.advanced}</SettingsAdvancedGroup>
      </SettingsSection>
      {fields.resetConfirmation}
    </Stack>
  );
}

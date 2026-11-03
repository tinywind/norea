import { Button, Menu, Tabs } from "@mantine/core";
import { useState } from "react";
import type { TranslationKey } from "../../i18n";
import { BackIconButton } from "../BackIconButton";
import { IconButton } from "../IconButton";
import {
  buildReaderSettingsFields,
  getReaderThemeLabel,
  useReaderSettingsEditor,
  type ReaderSettingsContentContext,
  type ReaderSettingsEditor,
  type ReaderSettingsPanelTarget,
  type ReaderSettingsScopeKind,
} from "../ReaderSettingsPanel";
import { SettingsSection } from "../SettingsPrimitives";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
} from "../ui/icons";

type ReaderQuickSettingsLevel = "quick" | "more";
type ReaderMoreSettingsSection =
  | "reading"
  | "controls"
  | "indicators"
  | "colors"
  | "advanced";

const SCOPE_LABEL_KEYS: Record<ReaderSettingsScopeKind, TranslationKey> = {
  global: "readerSettings.scope.applyToAll",
  source: "readerSettings.scope.applyToSource",
  novel: "readerSettings.scope.applyToNovel",
};

const MORE_SETTINGS_SECTIONS: Array<{
  value: ReaderMoreSettingsSection;
  labelKey: TranslationKey;
}> = [
  { value: "reading", labelKey: "readerSettings.reading.title" },
  { value: "controls", labelKey: "readerSettings.controls.title" },
  { value: "indicators", labelKey: "readerSettings.indicators.title" },
  { value: "colors", labelKey: "readerSettings.colors.title" },
  { value: "advanced", labelKey: "readerSettings.advanced" },
];

interface ReaderQuickSettingsProps {
  content: ReaderSettingsContentContext;
  target: ReaderSettingsPanelTarget;
}

/**
 * The reader's "Aa" settings: the most used controls first, with the grouped
 * settings one level down inside the same surface.
 */
export function ReaderQuickSettings({ content, target }: ReaderQuickSettingsProps) {
  const editor = useReaderSettingsEditor({ target, editEffectiveScope: true });
  const [level, setLevel] = useState<ReaderQuickSettingsLevel>("quick");
  const [section, setSection] =
    useState<ReaderMoreSettingsSection>("reading");
  const { t, appearance, general } = editor;
  const fields = buildReaderSettingsFields(editor);
  const paged = general.pageReader;

  if (editor.settingsLocked) {
    return (
      <div className="norea-reader-quick">
        <div className="norea-reader-quick-body">
          {fields.scope}
          {fields.lockedNotice}
        </div>
      </div>
    );
  }

  if (level === "more") {
    return (
      <div className="norea-reader-quick">
        <div className="norea-reader-quick-heading">
          <BackIconButton
            className="norea-reader-icon-button norea-state-layer"
            onClick={() => setLevel("quick")}
          />
          <h3 className="norea-reader-quick-title">
            {t("readerSettings.moreSettings")}
          </h3>
        </div>
        <Tabs
          className="norea-reader-quick-tabs"
          keepMounted={false}
          onChange={(value) => {
            if (value) setSection(value as ReaderMoreSettingsSection);
          }}
          value={section}
        >
          <Tabs.List className="norea-reader-settings-tab-list">
            {MORE_SETTINGS_SECTIONS.map((entry) => (
              <Tabs.Tab key={entry.value} value={entry.value}>
                {t(entry.labelKey)}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <div className="norea-reader-quick-body">
            <Tabs.Panel value="reading">
              <SettingsSection>
                {fields.fullPageReader}
                {fields.keepScreenOn}
                {paged ? fields.pageTransition : null}
                {paged && content.kind === "pdf" ? fields.pdfPageFit : null}
                {paged && content.kind === "html" && content.hasImages
                  ? fields.htmlImagePaging
                  : null}
              </SettingsSection>
            </Tabs.Panel>
            <Tabs.Panel value="controls">
              <SettingsSection>{fields.controls}</SettingsSection>
            </Tabs.Panel>
            <Tabs.Panel value="indicators">
              <SettingsSection>{fields.indicators}</SettingsSection>
            </Tabs.Panel>
            <Tabs.Panel value="colors">
              <SettingsSection>
                {fields.backgroundColor}
                {fields.textColor}
                {fields.saveTheme}
              </SettingsSection>
            </Tabs.Panel>
            <Tabs.Panel value="advanced">
              <SettingsSection>{fields.advanced}</SettingsSection>
            </Tabs.Panel>
          </div>
        </Tabs>
        <div className="norea-reader-quick-footer">{fields.reset}</div>
        {fields.resetConfirmation}
      </div>
    );
  }

  return (
    <div className="norea-reader-quick">
      <div className="norea-reader-quick-top">
        <ReaderScopeMenu editor={editor} />
        <SettingStepper
          editor={editor}
          label={t("readerSettings.quickTextSize")}
          max={36}
          min={12}
          onChange={(textSize) => editor.setActiveAppearance({ textSize })}
          step={1}
          value={appearance.textSize}
          valueLabel={`${appearance.textSize}`}
        />
        <div
          aria-label={t("readerSettings.quickTheme")}
          className="norea-reader-quick-row"
          role="group"
        >
          <span className="norea-reader-quick-label">
            {t("readerSettings.quickTheme")}
          </span>
          <div className="norea-reader-theme-swatches">
            {editor.readerThemes.map((theme) => (
              <button
                aria-label={getReaderThemeLabel(theme.id, theme.label, t)}
                aria-pressed={theme.id === appearance.themeId}
                className="norea-reader-theme-swatch norea-state-layer"
                key={theme.id}
                onClick={() => editor.applyActiveTheme(theme)}
                style={{ background: theme.backgroundColor }}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className="norea-reader-theme-swatch-ink"
                  style={{ background: theme.textColor }}
                />
              </button>
            ))}
          </div>
        </div>
        {fields.readingMode}
      </div>
      <div className="norea-reader-quick-body">
        <SettingStepper
          editor={editor}
          label={t("readerSettings.quickLineHeight")}
          max={2.6}
          min={1}
          onChange={(lineHeight) => editor.setActiveAppearance({ lineHeight })}
          step={0.1}
          value={appearance.lineHeight}
          valueLabel={appearance.lineHeight.toFixed(1)}
        />
        <SettingStepper
          editor={editor}
          label={t("readerSettings.quickPadding")}
          max={64}
          min={0}
          onChange={(padding) => editor.setActiveAppearance({ padding })}
          step={2}
          value={appearance.padding}
          valueLabel={`${appearance.padding}`}
        />
        <SettingsSection>
          {fields.font}
          {fields.alignment}
          {paged ? null : fields.autoScroll}
        </SettingsSection>
        <button
          className="norea-reader-quick-more norea-state-layer"
          onClick={() => setLevel("more")}
          type="button"
        >
          <span>{t("readerSettings.moreSettings")}</span>
          <ChevronRightIcon />
        </button>
      </div>
      {fields.resetConfirmation}
    </div>
  );
}

/**
 * RD23: "Applying to: <scope>" picks the scope "Aa" edits, turns a narrower
 * scope off again, or copies it to all novels. A notice points at a narrower
 * scope that overrides the edited one.
 */
function ReaderScopeMenu({ editor }: { editor: ReaderSettingsEditor }) {
  const { t, effectiveScopeTarget, overridingScope, targetKind } = editor;
  if (!effectiveScopeTarget) return null;
  const scopes: ReaderSettingsScopeKind[] = effectiveScopeTarget.sourceId
    ? ["global", "source", "novel"]
    : ["global", "novel"];

  return (
    <div className="norea-reader-scope">
      <Menu position="bottom-start" returnFocus shadow="md" withinPortal>
        <Menu.Target>
          <Button
            className="norea-reader-scope-trigger"
            rightSection={<ChevronDownIcon aria-hidden="true" size="1rem" />}
            size="compact-sm"
            variant="subtle"
          >
            {t("readerSettings.scope.applyingTo", {
              scope: t(SCOPE_LABEL_KEYS[targetKind]),
            })}
          </Button>
        </Menu.Target>
        <Menu.Dropdown aria-label={t("readerSettings.scope.applyTo")}>
          {scopes.map((scope) => (
            <Menu.Item
              aria-current={scope === targetKind ? "true" : undefined}
              key={scope}
              leftSection={
                scope === targetKind ? (
                  <CheckIcon aria-hidden="true" size="1.125rem" />
                ) : (
                  <span aria-hidden="true" className="norea-reader-scope-check-space" />
                )
              }
              onClick={() => editor.selectEditScope(scope)}
            >
              {t(SCOPE_LABEL_KEYS[scope])}
            </Menu.Item>
          ))}
          {targetKind === "global" ? null : (
            <>
              <Menu.Divider />
              <Menu.Item onClick={editor.inheritScopeSettings}>
                {t("readerSettings.scope.useInherited")}
              </Menu.Item>
              <Menu.Item onClick={editor.copyScopeSettingsToGlobal}>
                {t("readerSettings.scope.useForAll")}
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
      {overridingScope ? (
        <p className="norea-reader-scope-notice" role="status">
          <span>
            {t(
              overridingScope === "novel"
                ? "readerSettings.scope.novelOverrides"
                : "readerSettings.scope.sourceOverrides",
            )}
          </span>
          <Button
            onClick={() => editor.selectEditScope(overridingScope)}
            size="compact-sm"
            variant="light"
          >
            {t(
              overridingScope === "novel"
                ? "readerSettings.scope.editNovel"
                : "readerSettings.scope.editSource",
            )}
          </Button>
        </p>
      ) : null}
    </div>
  );
}

function SettingStepper({
  editor,
  label,
  max,
  min,
  onChange,
  step,
  value,
  valueLabel,
}: {
  editor: ReaderSettingsEditor;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
  valueLabel: string;
}) {
  const { t } = editor;
  const change = (direction: 1 | -1) => {
    const next = Math.round((value + direction * step) * 100) / 100;
    onChange(Math.max(min, Math.min(max, next)));
  };

  return (
    <div aria-label={label} className="norea-reader-quick-row" role="group">
      <span className="norea-reader-quick-label">{label}</span>
      <div className="norea-reader-stepper">
        <IconButton
          className="norea-reader-icon-button norea-state-layer"
          disabled={value <= min}
          label={t("readerSettings.stepper.decrease", { label })}
          onClick={() => change(-1)}
          size="sm"
        >
          <MinusIcon />
        </IconButton>
        <output className="norea-reader-stepper-value">{valueLabel}</output>
        <IconButton
          className="norea-reader-icon-button norea-state-layer"
          disabled={value >= max}
          label={t("readerSettings.stepper.increase", { label })}
          onClick={() => change(1)}
          size="sm"
        >
          <PlusIcon />
        </IconButton>
      </div>
    </div>
  );
}

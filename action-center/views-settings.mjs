// CIVION Mail — the Settings projection.
//
// One function fills the Settings controls from the settings the background holds, and
// one reads them back into the patch Save sends. Both take the controls as an argument
// and touch nothing else, so the projection can be executed outside the page. The
// defect this file exists for was a form that showed the HTML defaults instead of the
// stored values whenever Settings was reached by navigation rather than through the one
// button that filled it — a behaviour, not a string a test can grep for.
//
// There is no copy of the settings here. `settings` is the background's answer exactly
// as app.js holds it; the controls are the only other place a value exists, and that
// value is an unsaved edit. The defaults are not restated either: a missing value
// projects the same way the background normalises it, and nowhere else.

export const SETTINGS_CONTROL_IDS = Object.freeze([
  "settingAutoTag",
  "settingAnalyzeJunk",
  "settingDesktopBridge",
  "settingDocumentArchive",
  "settingRetention",
  "settingMaxRecords",
  "settingDiagnostics",
  "settingTrustedAuthserv"
]);

/** Write the stored settings into the controls. Every control is written, every time. */
export function hydrateSettings(controls, settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  controls.settingAutoTag.checked = source.autoTag === true;
  controls.settingAnalyzeJunk.checked = source.analyzeJunk === true;
  controls.settingDesktopBridge.checked = source.desktopBridgeEnabled !== false;
  controls.settingDocumentArchive.checked = source.automaticDocumentArchive !== false;
  controls.settingRetention.value = String(source.retentionDays || 365);
  controls.settingMaxRecords.value = String(source.maxRecords || 2000);
  controls.settingDiagnostics.checked = source.diagnosticLogging === true;
  controls.settingTrustedAuthserv.value = Array.isArray(source.trustedAuthservIds)
    ? source.trustedAuthservIds.join(", ")
    : "";
}

/** Read the controls back into the patch Save sends. The background normalises it. */
export function readSettingsPatch(controls) {
  return {
    autoTag: controls.settingAutoTag.checked,
    analyzeJunk: controls.settingAnalyzeJunk.checked,
    desktopBridgeEnabled: controls.settingDesktopBridge.checked,
    automaticDocumentArchive: controls.settingDocumentArchive.checked,
    retentionDays: Number(controls.settingRetention.value),
    maxRecords: Number(controls.settingMaxRecords.value),
    diagnosticLogging: controls.settingDiagnostics.checked,
    trustedAuthservIds: controls.settingTrustedAuthserv.value
  };
}

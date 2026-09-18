// Harness check: Settings shows the stored values on every path (0.8.4, 029 §3.1).
//
// The defect this guards against: the form was filled by the one button that used to
// open the dialog, so arriving by the rail, by a shortcut, or on the way back after Save
// showed the HTML defaults — for the bridge and the archive the opposite of what was
// stored. tests/run-tests.mjs executes the projection; this drives the page, so the
// shell's "show" event, the rail, Save's automatic exit and the legacy showModal() path
// are exercised as a person would hit them.
//
//   BASE_URL=http://localhost:8712 node tests/ui-harness/check-settings-hydration.mjs

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.BASE_URL || "http://localhost:8712";
const STUB = fileURLToPath(new URL("./messenger-stub.mjs", import.meta.url));

const failures = [];
function expect(name, condition, detail = "") {
  if (condition) console.log(`PASS  ${name}`);
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const browser = await chromium.launch();
const errors = [];

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript({ path: STUB });
  await page.goto(`${BASE_URL}/action-center/index.r005.html`);
  await page.waitForFunction(() => document.querySelectorAll("#recordsBody tr").length > 0);
  return page;
}

const READ_FORM = () => ({
  screen: document.querySelector('.screen[data-on="true"]')?.dataset.screen,
  bridge: document.getElementById("settingDesktopBridge").checked,
  archive: document.getElementById("settingDocumentArchive").checked,
  junk: document.getElementById("settingAnalyzeJunk").checked,
  autoTag: document.getElementById("settingAutoTag").checked,
  retention: document.getElementById("settingRetention").value,
  maxRecords: document.getElementById("settingMaxRecords").value,
  diagnostics: document.getElementById("settingDiagnostics").checked,
  authserv: document.getElementById("settingTrustedAuthserv").value
});

// 1. Cold open, then the rail. The stored defaults are bridge on, archive on, junk off.
{
  const page = await openPage();
  await page.click('.rail-btn[data-go="settings"]');
  const form = await page.evaluate(READ_FORM);
  expect("cold open → rail → Settings shows the stored values, not the HTML defaults",
    form.screen === "settings" && form.bridge === true && form.archive === true && form.junk === false
    && form.retention === "365" && form.maxRecords === "2000" && form.autoTag === false && form.diagnostics === false,
    JSON.stringify(form));

  // 2. Save false → the screen is left automatically → return in the same session.
  await page.uncheck("#settingDesktopBridge");
  await page.uncheck("#settingDocumentArchive");
  await page.fill("#settingRetention", "90");
  await page.fill("#settingTrustedAuthserv", "mx.example.invalid");
  await page.click("#saveSettingsButton");
  await page.waitForFunction(() => document.querySelector('.screen[data-on="true"]')?.dataset.screen === "records");
  await page.click('.rail-btn[data-go="settings"]');
  const after = await page.evaluate(READ_FORM);
  expect("Save false → automatic exit to Records → return shows the saved values",
    after.screen === "settings" && after.bridge === false && after.archive === false
    && after.retention === "90" && after.authserv === "mx.example.invalid",
    JSON.stringify(after));

  // 3. Reload in the same tab: what was saved is what is shown.
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#recordsBody tr").length > 0);
  await page.click('.rail-btn[data-go="settings"]');
  const reloaded = await page.evaluate(READ_FORM);
  expect("reload → Settings still shows false / 90",
    reloaded.bridge === false && reloaded.archive === false && reloaded.retention === "90", JSON.stringify(reloaded));

  // 4. Save true → reload → shown true.
  await page.check("#settingDesktopBridge");
  await page.check("#settingDocumentArchive");
  await page.check("#settingAnalyzeJunk");
  await page.click("#saveSettingsButton");
  await page.waitForFunction(() => document.querySelector('.screen[data-on="true"]')?.dataset.screen === "records");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#recordsBody tr").length > 0);
  await page.click('.rail-btn[data-go="settings"]');
  const trueAgain = await page.evaluate(READ_FORM);
  expect("Save true → reload → shown true, for bridge, archive and junk",
    trueAgain.bridge === true && trueAgain.archive === true && trueAgain.junk === true, JSON.stringify(trueAgain));

  // 5. A shortcut from another screen is an arrival too.
  await page.click('.rail-btn[data-go="trust"]');
  await page.click('[data-screen="trust"] [data-go="settings"]');
  const viaTrust = await page.evaluate(READ_FORM);
  expect("the Trust → Settings shortcut shows the same values as the rail",
    viaTrust.screen === "settings" && viaTrust.junk === true && viaTrust.retention === "90", JSON.stringify(viaTrust));
  await page.close();
}

// 6. The legacy showModal() path, from a cold page, gives the same values as navigation.
{
  const page = await openPage();
  await page.evaluate(() => document.getElementById("settingsDialog").showModal());
  const legacy = await page.evaluate(READ_FORM);
  const other = await openPage();
  await other.click('.rail-btn[data-go="settings"]');
  const direct = await other.evaluate(READ_FORM);
  expect("showModal() and direct navigation fill the form identically",
    legacy.screen === "settings" && JSON.stringify(legacy) === JSON.stringify(direct),
    `${JSON.stringify(legacy)} vs ${JSON.stringify(direct)}`);
  await page.close();
  await other.close();
}

expect("no console error along the way", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);

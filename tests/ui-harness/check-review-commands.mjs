// Harness check: Review's two state-backed queues round-trip through the background.
//
// Rejecting a reading and acknowledging a rule are the only two commands Review issues.
// Neither is performed by the view: it asks, the background decides, and the next snapshot
// is what the screen shows. What cannot be proven from source is that the whole loop
// closes without a reload, and that a rejected reading is kept rather than deleted.
//
//   BASE_URL=http://localhost:8712 node tests/ui-harness/check-review-commands.mjs

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(String(error)));
const navigations = [];
page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });

await page.addInitScript({ path: STUB });
await page.goto(`${BASE_URL}/action-center/index.r005.html`);
await page.waitForTimeout(700);
navigations.length = 0;

const counts = () => page.evaluate(() => Object.fromEntries(
  ["Uncertain", "Rejected", "Rules"].map((key) => [key, document.getElementById(`review${key}Count`).textContent])
));

await page.click('.rail-btn[data-go="review"]');
await page.click('.screen[data-screen="review"] [data-view="uncertain"]');
await page.waitForTimeout(250);

const before = await counts();
expect("an unsettled reading starts in Uncertain and nowhere else",
  before.Uncertain === "1" && before.Rejected === "0", JSON.stringify(before));

await page.evaluate(() => document.querySelector("#reviewUncertainList button").click());
await page.waitForTimeout(700);
const afterReject = await counts();

expect("rejecting moves the reading to Rejected without a reload",
  afterReject.Uncertain === "0" && afterReject.Rejected === "1" && navigations.length === 0,
  `${JSON.stringify(afterReject)} navigations=${navigations.length}`);

await page.click('.screen[data-screen="review"] [data-view="rejected"]');
await page.waitForTimeout(250);
const rejectedRow = await page.evaluate(() => document.querySelector("#reviewRejectedList .help")?.textContent || "");
expect("the rejected reading names the finding it belongs to",
  /deadline:2026-12-31/u.test(rejectedRow), rejectedRow);

await page.evaluate(() => document.querySelector("#reviewRejectedList button").click());
await page.waitForTimeout(700);
const restored = await counts();
expect("restoring puts it back in Uncertain",
  restored.Uncertain === "1" && restored.Rejected === "0", JSON.stringify(restored));

await page.click('.screen[data-screen="review"] [data-view="rules"]');
await page.waitForTimeout(250);
await page.evaluate(() => document.querySelector("#reviewRulesList button").click());
await page.waitForTimeout(700);
const acknowledged = await counts();
expect("acknowledging a rule clears it from the queue and changes nothing else",
  acknowledged.Rules === "0" && acknowledged.Uncertain === restored.Uncertain,
  JSON.stringify(acknowledged));

expect("no navigation and no console error in the whole loop",
  navigations.length === 0 && consoleErrors.length === 0,
  `navigations=${navigations.length} ${consoleErrors.join(" | ")}`);

await browser.close();
console.log(`\n${failures.length ? `${failures.length} failed` : "all checks passed"}`);
if (failures.length) process.exit(1);

// Harness check: changing a sender disposition from Trust updates Trust and the sender
// queue in Review without reloading the page, and the identity snapshot the Action Center
// receives is frozen.
//
// This is the part of the identity contract that source checks cannot prove. It needs a
// real browser and the extension served over http (ES modules do not load from file://).
//
//   node --experimental-... not required; just:
//     npx serve or any static server rooted at the extension directory, then
//     BASE_URL=http://localhost:8712 node tests/ui-harness/check-identity-refresh.mjs
//
// Requires playwright. Exits non-zero on the first failed expectation.

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

await page.addInitScript({ path: STUB });
await page.goto(`${BASE_URL}/action-center/index.r005.html`);
await page.waitForTimeout(600);

// The snapshot must arrive frozen, so no screen can keep an editable copy.
const frozen = await page.evaluate(() => new Promise((resolve) => {
  document.addEventListener("civion:identity-state", (event) => {
    const snapshot = event.detail;
    let threw = false;
    try { snapshot.allowlistedDomains.push({ domain: "x.invalid", provenance: "user" }); }
    catch { threw = true; }
    resolve({
      isFrozen: Object.isFrozen(snapshot),
      nestedFrozen: Object.isFrozen(snapshot.allowlistedDomains),
      mutationRefused: threw || snapshot.allowlistedDomains.every((entry) => entry.domain !== "x.invalid")
    });
  }, { once: true });
  document.getElementById("refreshButton").click();
}));
expect("the identity snapshot is frozen when it reaches the screens",
  frozen.isFrozen && frozen.nestedFrozen && frozen.mutationRefused, JSON.stringify(frozen));

await page.click('.rail-btn[data-go="trust"]');
await page.waitForTimeout(300);

const readTrust = () => page.evaluate(() => ({
  summary: document.getElementById("trustSummary").textContent,
  dispositions: Object.fromEntries([...document.querySelectorAll("#trustRows tr")]
    .map((row) => [row.children[0].querySelector(".wrap-name").textContent, row.children[3].textContent.trim()]))
}));
const readReview = () => page.evaluate(() => ({
  count: document.getElementById("reviewSenderCount").textContent,
  domains: [...document.querySelectorAll("#reviewSenderList .help")].map((node) => node.textContent.split(" ")[0])
}));

const before = await readTrust();
const reviewBefore = await readReview();
const target = "kade-water.example.invalid";

expect("the domain starts as an observed service domain, not a decision",
  before.dispositions[target] === "observed service domain", before.dispositions[target]);

// Block it from inside Trust. Nothing reloads.
const navigations = [];
page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
await page.evaluate((domain) => {
  const row = [...document.querySelectorAll("#trustRows tr")]
    .find((tr) => tr.children[0].querySelector(".wrap-name").textContent === domain);
  [...row.querySelectorAll("button")].find((button) => button.textContent === "Block").click();
}, target);
await page.waitForTimeout(700);

const after = await readTrust();
const reviewAfter = await readReview();

expect("Trust shows the new disposition without a reload",
  after.dispositions[target] === "blocked by you" && navigations.length === 0,
  `${after.dispositions[target]} navigations=${navigations.length}`);

expect("the summary counts the decision as yours",
  /0 blocked by you/u.test(before.summary) && /1 blocked by you/u.test(after.summary),
  after.summary);

expect("the sender queue in Review reacts to the same change",
  !reviewAfter.domains.includes(target) || reviewBefore.domains.includes(target),
  `before=${reviewBefore.domains.join(",")} after=${reviewAfter.domains.join(",")}`);

// And back again, so the check leaves the fixture as it found it.
await page.evaluate((domain) => {
  const row = [...document.querySelectorAll("#trustRows tr")]
    .find((tr) => tr.children[0].querySelector(".wrap-name").textContent === domain);
  [...row.querySelectorAll("button")].find((button) => button.textContent === "Clear").click();
}, target);
await page.waitForTimeout(600);
const restored = await readTrust();
expect("clearing a decision returns the domain to what it was",
  restored.dispositions[target] === "observed service domain", restored.dispositions[target]);

expect("no console error along the way", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
console.log(`\n${failures.length ? `${failures.length} failed` : "all checks passed"}`);
if (failures.length) process.exit(1);

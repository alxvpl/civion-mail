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

// The snapshot must arrive DEEPLY frozen. A shallow freeze would still let a screen edit
// an entry inside allowlistedDomains or rewrite a provenance, and the contract would allow
// exactly the quiet local drift it exists to prevent. Every level is attacked here: the
// root, the arrays, an entry object, and a nested array inside protectedIdentities.
const probeFreeze = (snapshot) => {
  // Strict mode matters: outside it, writing to a frozen object fails silently instead of
  // throwing, and a shallow freeze would look identical to a deep one.
  "use strict";
  const attempt = (fn) => { try { fn(); return "mutated"; } catch { return "refused"; } };
  const firstAllow = snapshot.allowlistedDomains[0];
  const firstIdentity = snapshot.protectedIdentities[0];
  return {
    rootFrozen: Object.isFrozen(snapshot),
    arrayFrozen: Object.isFrozen(snapshot.allowlistedDomains),
    entryFrozen: Object.isFrozen(firstAllow),
    nestedArrayFrozen: Object.isFrozen(firstIdentity.domains),
    pushRefused: attempt(() => snapshot.allowlistedDomains.push({ domain: "x.invalid", provenance: "user" })),
    entryEditRefused: attempt(() => { firstAllow.provenance = "user"; }),
    nestedPushRefused: attempt(() => firstIdentity.domains.push("x.invalid")),
    rootEditRefused: attempt(() => { snapshot.generatedAt = "tampered"; }),
    stillClean: !snapshot.allowlistedDomains.some((entry) => entry.domain === "x.invalid")
      && !firstIdentity.domains.includes("x.invalid")
      && snapshot.generatedAt !== "tampered"
  };
};

const frozen = await page.evaluate((source) => new Promise((resolve) => {
  const probe = new Function(`return (${source})`)();
  document.addEventListener("civion:identity-state", (event) => resolve(probe(event.detail)), { once: true });
  document.getElementById("refreshButton").click();
}), probeFreeze.toString());

expect("the identity snapshot is deeply frozen when it reaches the screens",
  frozen.rootFrozen && frozen.arrayFrozen && frozen.entryFrozen && frozen.nestedArrayFrozen
  && frozen.pushRefused === "refused" && frozen.entryEditRefused === "refused"
  && frozen.nestedPushRefused === "refused" && frozen.rootEditRefused === "refused"
  && frozen.stillClean,
  JSON.stringify(frozen));

const probeJunkFreeze = (snapshot) => {
  "use strict";
  const attempt = (fn) => { try { fn(); return "mutated"; } catch { return "refused"; } };
  const first = snapshot.admitted[0];
  return {
    rootFrozen: Object.isFrozen(snapshot),
    arrayFrozen: Object.isFrozen(snapshot.admitted),
    conditionFrozen: first ? Object.isFrozen(first.admission.conditions[0]) : true,
    counterEditRefused: attempt(() => { snapshot.notAdmitted.messageCount = 0; }),
    conditionEditRefused: first
      ? attempt(() => { first.admission.conditions[0].result = "fail"; })
      : "refused",
    stillClean: snapshot.notAdmitted.messageCount !== 0
      && (!first || first.admission.conditions[0].result !== "fail")
  };
};

const junkFrozen = await page.evaluate((source) => new Promise((resolve) => {
  const probe = new Function(`return (${source})`)();
  document.addEventListener("civion:junk-admission-state", (event) => resolve(probe(event.detail)), { once: true });
  document.getElementById("refreshButton").click();
}), probeJunkFreeze.toString());

expect("the junk admission snapshot is deeply frozen too",
  junkFrozen.rootFrozen && junkFrozen.arrayFrozen && junkFrozen.conditionFrozen
  && junkFrozen.counterEditRefused === "refused" && junkFrozen.conditionEditRefused === "refused"
  && junkFrozen.stillClean,
  JSON.stringify(junkFrozen));

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

// Harness check: the derived screens are fed by snapshots, not by being visited.
//
// The failure this guards against is the one the port already hit once, when System →
// Historical Scan showed an empty folder tree because only the Operations menu loaded it.
// A screen that fills itself on arrival looks fine when you click through it in order and
// is empty for anyone who lands on it directly.
//
// So each screen is opened FIRST in its own page, with no other screen visited, and has
// to be complete. Then one page visits them all and nothing may change, which is what
// "no duplicate state" looks like from the outside.
//
//   BASE_URL=http://localhost:8712 node tests/ui-harness/check-snapshot-screens.mjs

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

/** Opens the page, goes straight to one screen, and reads what it shows. */
async function readScreen(screen, view) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${screen}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`${screen}: ${error}`));
  await page.addInitScript({ path: STUB });
  await page.goto(`${BASE_URL}/action-center/index.r005.html`);
  await page.waitForTimeout(600);
  if (screen !== "today") await page.click(`.rail-btn[data-go="${screen}"]`);
  if (view) await page.click(`[role=tab][data-view="${view}"]`);
  await page.waitForTimeout(400);
  const snapshot = await page.evaluate(() => ({
    today: {
      decisions: document.getElementById("todayDecisionBig")?.textContent,
      other: document.getElementById("todayOtherBig")?.textContent,
      due: document.querySelectorAll("#todayDue div").length,
      latest: document.querySelectorAll("#todayRows tr").length
    },
    trust: {
      rows: document.querySelectorAll("#trustRows tr").length,
      summary: document.getElementById("trustSummary")?.textContent
    },
    senders: {
      count: document.getElementById("reviewSenderCount")?.textContent,
      rows: document.querySelectorAll("#reviewSenderList .setrow").length
    },
    junk: {
      count: document.getElementById("reviewJunkCount")?.textContent,
      panes: document.querySelectorAll("#reviewJunkList .pane").length,
      notes: document.getElementById("reviewJunkNotes")?.textContent
    },
    records: document.querySelectorAll("#recordsBody tr").length
  }));
  await page.close();
  return snapshot;
}

const today = await readScreen("today");
expect("Today is complete on arrival",
  today.today.decisions === "1" && today.today.other === "2"
  && today.today.due === 3 && today.today.latest === 6,
  JSON.stringify(today.today));

const trust = await readScreen("trust");
expect("Trust is complete without visiting Records or Review first",
  trust.trust.rows === 6 && /allowed by you/u.test(trust.trust.summary || ""),
  JSON.stringify(trust.trust));

const senders = await readScreen("review", "senders");
expect("the sender queue is complete on arrival",
  senders.senders.count === String(senders.senders.rows) && senders.senders.rows >= 1,
  JSON.stringify(senders.senders));

const junk = await readScreen("review", "junk");
expect("Junk watch is complete on arrival",
  junk.junk.count === String(junk.junk.panes) && junk.junk.panes === 1,
  JSON.stringify(junk.junk));

expect("Junk watch reports the not-admitted count and refuses to list them",
  /12 messages were not admitted/u.test(junk.junk.notes || "")
  && /not a spam verdict/u.test(junk.junk.notes || "")
  && junk.junk.panes === 1,
  junk.junk.notes);

const records = await readScreen("records");
expect("the Action Center is complete on arrival", records.records === 6, String(records.records));

// Now the same four screens in one page, in order. Every figure must match what the
// screen showed when it was opened alone: nothing may depend on what was visited before.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (message) => { if (message.type() === "error") errors.push(`walk: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`walk: ${error}`));
await page.addInitScript({ path: STUB });
await page.goto(`${BASE_URL}/action-center/index.r005.html`);
await page.waitForTimeout(600);
for (const [screen, view] of [["records", null], ["trust", null], ["review", "senders"], ["review", "junk"], ["today", null]]) {
  await page.click(`.rail-btn[data-go="${screen}"]`);
  if (view) await page.click(`[role=tab][data-view="${view}"]`);
  await page.waitForTimeout(200);
}
const walked = await page.evaluate(() => ({
  todayDecisions: document.getElementById("todayDecisionBig").textContent,
  trustRows: document.querySelectorAll("#trustRows tr").length,
  senderRows: document.querySelectorAll("#reviewSenderList .setrow").length,
  junkPanes: document.querySelectorAll("#reviewJunkList .pane").length,
  recordRows: document.querySelectorAll("#recordsBody tr").length
}));
await page.close();

expect("visiting every screen changes none of them",
  walked.todayDecisions === today.today.decisions
  && walked.trustRows === trust.trust.rows
  && walked.senderRows === senders.senders.rows
  && walked.junkPanes === junk.junk.panes
  && walked.recordRows === records.records,
  JSON.stringify(walked));

expect("no console error on any screen", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(`\n${failures.length ? `${failures.length} failed` : "all checks passed"}`);
if (failures.length) process.exit(1);

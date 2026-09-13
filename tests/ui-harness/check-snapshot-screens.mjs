// Harness check: every surface is fed by snapshots, not by being visited.
//
// The failure this guards against is the one the port already hit once, when System →
// Historical Scan showed an empty folder tree because only the Operations menu loaded it.
// A screen that fills itself on arrival looks fine when you click through it in order and
// is empty for anyone who lands on it directly.
//
// Three passes:
//   1. each surface opened FIRST in its own page, with nothing else visited, must be
//      complete;
//   2. all of them walked in one page, in a shuffled order, must show the same figures;
//   3. a selection made on one screen must survive a trip through the others.
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

// Everything a surface is judged by, read the same way in every pass.
const READ = () => ({
  today: {
    decisions: document.getElementById("todayDecisionBig")?.textContent,
    other: document.getElementById("todayOtherBig")?.textContent,
    due: document.querySelectorAll("#todayDue div").length,
    latest: document.querySelectorAll("#todayRows tr").length
  },
  records: document.querySelectorAll("#recordsBody tr").length,
  dates: {
    counts: Object.fromEntries(["all", "obliging", "optional", "overdue"]
      .map((key) => [key, document.getElementById(`datesCount-${key}`)?.textContent])),
    rows: [...document.querySelectorAll("#datesRows tr")].filter((row) => !row.classList.contains("month-rule")).length
  },
  trust: {
    rows: document.querySelectorAll("#trustRows tr").length,
    summary: document.getElementById("trustSummary")?.textContent
  },
  review: {
    counts: Object.fromEntries(["Uncertain", "Sender", "Junk", "Unreadable", "Incorrect", "Rejected", "Rules"]
      .map((key) => [key, document.getElementById(`review${key}Count`)?.textContent])),
    rows: Object.fromEntries([
      ["Uncertain", "reviewUncertainList"], ["Sender", "reviewSenderList"],
      ["Unreadable", "reviewUnreadableList"], ["Incorrect", "reviewIncorrectList"],
      ["Rejected", "reviewRejectedList"], ["Rules", "reviewRulesList"]
    ].map(([key, id]) => [key, document.querySelectorAll(`#${id} .setrow`).length])),
    junkPanes: document.querySelectorAll("#reviewJunkList .pane").length
  }
});

const SURFACES = [
  ["today", null], ["records", null], ["dates", null], ["trust", null],
  ["review", "uncertain"], ["review", "senders"], ["review", "junk"],
  ["review", "unreadable"], ["review", "incorrect"], ["review", "rejected"], ["review", "rules"]
];

async function open(label) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${label}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`${label}: ${error}`));
  await page.addInitScript({ path: STUB });
  await page.goto(`${BASE_URL}/action-center/index.r005.html`);
  await page.waitForTimeout(600);
  return page;
}

async function goTo(page, screen, view) {
  if (screen !== "today" || view) await page.click(`.rail-btn[data-go="${screen}"]`);
  if (view) await page.click(`.screen[data-screen="${screen}"] [data-view="${view}"]`);
  await page.waitForTimeout(250);
}

// ---- pass 1: each surface cold ------------------------------------------------

const cold = {};
for (const [screen, view] of SURFACES) {
  const page = await open(`${screen}/${view || "-"}`);
  await goTo(page, screen, view);
  cold[`${screen}/${view || "-"}`] = await page.evaluate(READ);
  await page.close();
}

const first = cold["today/-"];
expect("Today is complete when it is the first thing opened",
  first.today.decisions === "1" && first.today.other === "2" && first.today.due === 3 && first.today.latest === 6,
  JSON.stringify(first.today));

expect("the Action Center is complete when it is the first thing opened",
  cold["records/-"].records === 6, String(cold["records/-"].records));

expect("Dates is complete cold, and its counters match its list",
  cold["dates/-"].dates.rows === 8 && cold["dates/-"].dates.counts.all === "8"
  && cold["dates/-"].dates.counts.obliging === "3" && cold["dates/-"].dates.counts.optional === "1"
  && cold["dates/-"].dates.counts.overdue === "1",
  JSON.stringify(cold["dates/-"].dates));

expect("Trust is complete cold",
  cold["trust/-"].trust.rows === 6 && /allowed by you/u.test(cold["trust/-"].trust.summary || ""),
  JSON.stringify(cold["trust/-"].trust));

for (const [tab, key, listKey] of [
  ["uncertain", "Uncertain", "Uncertain"], ["senders", "Sender", "Sender"],
  ["unreadable", "Unreadable", "Unreadable"], ["incorrect", "Incorrect", "Incorrect"],
  ["rejected", "Rejected", "Rejected"], ["rules", "Rules", "Rules"]
]) {
  const state = cold[`review/${tab}`].review;
  expect(`Review → ${tab} is complete cold, and its counter matches its list`,
    state.counts[key] === String(state.rows[listKey]),
    `counter=${state.counts[key]} rows=${state.rows[listKey]}`);
}

const junkCold = cold["review/junk"].review;
expect("Review → junk is complete cold",
  junkCold.counts.Junk === String(junkCold.junkPanes) && junkCold.junkPanes === 1,
  `counter=${junkCold.counts.Junk} panes=${junkCold.junkPanes}`);

// ---- pass 2: shuffled walk ----------------------------------------------------

const shuffled = [...SURFACES].sort(() => Math.random() - 0.5);
const walkPage = await open("walk");
for (const [screen, view] of shuffled) await goTo(walkPage, screen, view);
const walked = await walkPage.evaluate(READ);
await walkPage.close();

expect("a shuffled walk through every surface changes no figure",
  JSON.stringify(walked.today) === JSON.stringify(first.today)
  && walked.records === cold["records/-"].records
  && JSON.stringify(walked.dates) === JSON.stringify(cold["dates/-"].dates)
  && walked.trust.rows === cold["trust/-"].trust.rows
  && JSON.stringify(walked.review.counts) === JSON.stringify(cold["review/uncertain"].review.counts)
  && walked.review.junkPanes === junkCold.junkPanes,
  `order=${shuffled.map(([s, v]) => `${s}/${v || "-"}`).join(",")} ${JSON.stringify(walked.review.counts)}`);

// ---- pass 3: selected state survives navigation --------------------------------

const selectionPage = await open("selection");
await goTo(selectionPage, "records", null);
await selectionPage.click("#recordsBody tr:nth-child(2)");
await selectionPage.waitForTimeout(250);
const selectedBefore = await selectionPage.evaluate(() => ({
  open: document.getElementById("detailDialog").open,
  subject: document.getElementById("detailSubject").textContent
}));
for (const [screen, view] of [["dates", null], ["trust", null], ["review", "rules"], ["today", null]]) {
  await goTo(selectionPage, screen, view);
}
await goTo(selectionPage, "records", null);
const selectedAfter = await selectionPage.evaluate(() => ({
  open: document.getElementById("detailDialog").open,
  subject: document.getElementById("detailSubject").textContent
}));
await selectionPage.close();

expect("a selected record survives a trip through the other screens",
  selectedBefore.open && selectedAfter.open && selectedBefore.subject === selectedAfter.subject
  && selectedBefore.subject.length > 0,
  `${JSON.stringify(selectedBefore)} -> ${JSON.stringify(selectedAfter)}`);

expect("no console error on any surface", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(`\n${failures.length ? `${failures.length} failed` : "all checks passed"}`);
if (failures.length) process.exit(1);

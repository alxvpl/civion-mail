// CIVION Mail — Action Center shell.
//
// Everything structural in the r005 design lives here: the rail, the tab strips, the
// three grounds, and the surface that used to be four <dialog> elements. app.js is not
// aware of any of it. It still calls showModal(), close() and reads .open on the five
// former dialogs, so this module gives those five elements exactly that surface and
// turns each call into navigation. The one rule that keeps this honest: this module
// owns no record state and renders no analysis — it moves the user between surfaces
// app.js fills.
//
// Loaded before app.js. Both are modules, so the DOM is parsed and this runs first.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- screens

function screens() {
  return $$(".screen");
}

function currentScreen() {
  return $('.screen[data-on="true"]');
}

/** The single routing contract. Every navigation in the shell goes through it. */
export function go(name, view) {
  const target = $(`.screen[data-screen="${CSS.escape(name)}"]`);
  if (!target) return;
  for (const screen of screens()) {
    screen.setAttribute("data-on", String(screen === target));
  }
  for (const button of $$(".rail-btn")) {
    button.setAttribute("aria-current", String(button.dataset.go === name));
  }
  if (view) selectTab(target, view);
  const body = $(".body", target);
  if (body) body.scrollTop = 0;
  closeContextMenu();
  announceVisible();
}

// A panel reached by navigation has to load the same data as one opened from the
// Operations menu, so every transition from hidden to visible fires one "show" event.
const SURFACES = [];
const wasOpen = new WeakMap();

function announceVisible() {
  for (const surface of SURFACES) {
    const open = surface.isOpen(surface.element);
    if (open && !wasOpen.get(surface.element)) surface.element.dispatchEvent(new Event("show"));
    wasOpen.set(surface.element, open);
  }
}

function closeContextMenu() {
  const menu = $("#recordContextMenu");
  if (menu && !menu.hidden) menu.hidden = true;
}

// Any element with data-go navigates: the rail, and the shortcuts inside a screen that
// point at another one. data-tab picks the view within the target screen.
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-go]");
  if (trigger) go(trigger.dataset.go, trigger.dataset.tab);
});

// Screens that are not the shell ask for navigation by event rather than by importing it.
document.addEventListener("civion:go", (event) => go(event.detail?.screen, event.detail?.view));

// ---------------------------------------------------------------- tabs

/**
 * A tab strip and its panels are matched by data-view inside one screen. Selection
 * moves aria-selected, the roving tabindex and the panel visibility together, so the
 * three can never disagree.
 */
function selectTab(screen, view) {
  const tabs = $$('[role="tab"][data-view]', screen);
  if (!tabs.length) return;
  const chosen = tabs.find((tab) => tab.dataset.view === view) || tabs[0];
  for (const tab of tabs) {
    const on = tab === chosen;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of $$('[role="tabpanel"][data-view]', screen)) {
    panel.hidden = panel.dataset.view !== chosen.dataset.view;
  }
  announceVisible();
}

function activeView(screen) {
  const tab = $('[role="tab"][data-view][aria-selected="true"]', screen);
  return tab ? tab.dataset.view : null;
}

for (const strip of $$('.tabs[role="tablist"]')) {
  const tabs = $$('[role="tab"]', strip);
  strip.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !tabs.includes(tab)) return;
    if (tab.dataset.view) selectTab(tab.closest(".screen"), tab.dataset.view);
    if (tab.dataset.themeSet) setTheme(tab.dataset.themeSet);
  });
  strip.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    let next = null;
    if (step) next = tabs[(index + step + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  });
}

// ---------------------------------------------------------------- grounds

const THEMES = new Set(["light", "dark", "system"]);
const THEME_KEY = "civion-mail-theme";

function setTheme(theme) {
  if (!THEMES.has(theme)) return;
  document.body.dataset.theme = theme;
  for (const button of $$("[data-theme-set]")) {
    const on = button.dataset.themeSet === theme;
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
  }
  // Best effort. A blocked or cleared store must not break the page.
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
}

let storedTheme = null;
try { storedTheme = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
setTheme(THEMES.has(storedTheme) ? storedTheme : "system");

// ------------------------------------------------- the former dialogs

/**
 * Give one element the part of the <dialog> surface app.js uses, and nothing more.
 * `show` reveals it, `hide` puts it away, and close() dispatches the close event the
 * two operation panels listen for.
 */
function asSurface(id, { show, hide, isOpen }) {
  const element = document.getElementById(id);
  if (!element) return;
  const reveal = () => {
    show(element);
    announceVisible();
  };
  element.showModal = reveal;
  element.show = reveal;
  element.close = () => {
    hide(element);
    wasOpen.set(element, false);
    element.dispatchEvent(new Event("close"));
  };
  Object.defineProperty(element, "open", { get: () => isOpen(element), configurable: true });
  SURFACES.push({ element, isOpen });
  wasOpen.set(element, isOpen(element));
}

// The detail is the second pane of the split, not a modal. Opening it hides the
// placeholder; closing it brings the placeholder back and leaves the list untouched.
const detailEmpty = $("#detailEmpty");
asSurface("detailDialog", {
  show(element) {
    go("records");
    element.hidden = false;
    if (detailEmpty) detailEmpty.hidden = true;
    element.scrollIntoView({ block: "nearest" });
  },
  hide(element) {
    element.hidden = true;
    if (detailEmpty) detailEmpty.hidden = false;
  },
  isOpen: (element) => !element.hidden
});

// Settings is a screen of its own.
asSurface("settingsDialog", {
  show: () => go("settings"),
  hide: () => go("records"),
  isOpen: () => currentScreen()?.dataset.screen === "settings"
});

// The three System panels are tabs, so opening one is navigation, and "open" means
// System is the current screen and that tab is the current view.
for (const [id, view] of [
  ["historicalScanDialog", "historical"],
  ["archiveExistingDialog", "archive"],
  ["diagnosticsDialog", "health"]
]) {
  asSurface(id, {
    show: () => go("system", view),
    hide: () => go("records"),
    isOpen: () => {
      const screen = currentScreen();
      return screen?.dataset.screen === "system" && activeView(screen) === view;
    }
  });
}

for (const button of $$("[data-close]")) {
  button.addEventListener("click", () => document.getElementById(button.dataset.close)?.close());
}

// The forms lost method="dialog" when the dialogs became screens, so a stray submit
// would reload the page and lose unsaved edits. Saving is a button in app.js.
for (const form of $$("form")) {
  form.addEventListener("submit", (event) => event.preventDefault());
}

// Escape closes whatever is open, innermost first, and never navigates past Records.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = $("#recordContextMenu");
  if (menu && !menu.hidden) { closeContextMenu(); return; }
  const detail = $("#detailDialog");
  if (detail && !detail.hidden) { detail.close(); return; }
  if (currentScreen()?.dataset.screen !== "records") go("records");
});

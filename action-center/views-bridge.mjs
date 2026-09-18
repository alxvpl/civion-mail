// CIVION Mail — System → Bridge.
//
// A projection of the bridge counters the background keeps in metadata, read from the
// state app.js publishes after every render. The derivation itself is in
// modules/bridge-state.mjs, shared with Self Check, so this file only puts words and a
// colour role on a result it did not compute. It owns no state, sends nothing, and
// never claims more than "this is what was last observed, and when".

import { deriveBridgeState } from "../modules/bridge-state.mjs";

const $ = (id) => document.getElementById(id);

function when(iso) {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value);
}

/** Render one derived state into the Bridge panel. Exported so the mapping can be executed. */
export function renderBridge(detail) {
  const bridge = deriveBridgeState(detail?.metadata?.desktopBridge);
  const chip = $("bridgeStateChip");
  if (chip) {
    chip.className = `chip ${bridge.role}`;
    chip.textContent = bridge.label;
    chip.setAttribute("data-state", bridge.state);
  }
  setText("bridgeStateNote", bridge.since ? `${bridge.note} Last known at ${when(bridge.since)}.` : bridge.note);
  setText("bridgeLastAttempt", bridge.lastAttemptAt
    ? `${when(bridge.lastAttemptAt)}${bridge.lastAttemptEvent ? ` (${bridge.lastAttemptEvent})` : ""}${bridge.probeOutcome ? ` · ${bridge.probeOutcome}` : " · no outcome recorded"}`
    : "—");
  setText("bridgeLastContact", when(bridge.lastContactAt));
  setText("bridgeLastFailure", when(bridge.lastFailureAt));
  setText("bridgeLastFailureCause", bridge.lastFailureCode
    ? `${bridge.lastFailureCode}${bridge.lastFailureReason ? ` / ${bridge.lastFailureReason}` : ""}`
    : "—");
  setText("bridgeEmitted", bridge.emittedCount);
  setText("bridgeBackfills", bridge.backfillCount);
  setText("bridgeFailures", bridge.failureCount);
  const disabled = $("bridgeDisabledNote");
  if (disabled) disabled.hidden = detail?.settings?.desktopBridgeEnabled !== false;
  return bridge;
}

if (typeof document !== "undefined") {
  document.addEventListener("civion:state", (event) => renderBridge(event.detail));
}

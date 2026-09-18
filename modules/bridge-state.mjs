// CIVION Mail — the state of the native transport, derived from what was recorded.
//
// The add-on watches one boundary: its own Native Messaging port to the Desktop host.
// It does not know whether Desktop is healthy, what Desktop did with a package after
// acknowledging it, or anything about the Mail domain — and this module says none of
// that. It reads the bridge counters and timestamps the background keeps in metadata
// and answers one question: what was the last thing this transport was seen to do,
// and when. Self Check and System → Bridge both call it, so the two cannot disagree.
//
// Four states, each with a name. The unknown ones are named rather than folded into
// success or failure, because a Boolean that has to say "I could not tell" says the
// optimistic thing.

export const BRIDGE_STATES = Object.freeze({
  NEVER_ATTEMPTED: "NEVER_ATTEMPTED",
  OK: "OK",
  FAILED: "FAILED",
  INDETERMINATE: "INDETERMINATE"
});

/** Presentation role per state: the colour role from the accepted design, never colour alone. */
export const BRIDGE_STATE_ROLES = Object.freeze({
  [BRIDGE_STATES.OK]: "confirmed",
  [BRIDGE_STATES.FAILED]: "alert",
  [BRIDGE_STATES.NEVER_ATTEMPTED]: "suggested",
  [BRIDGE_STATES.INDETERMINATE]: "suggested"
});

export const BRIDGE_STATE_LABELS = Object.freeze({
  [BRIDGE_STATES.OK]: "OK",
  [BRIDGE_STATES.FAILED]: "FAILED",
  [BRIDGE_STATES.NEVER_ATTEMPTED]: "NEVER ATTEMPTED",
  [BRIDGE_STATES.INDETERMINATE]: "INDETERMINATE"
});

function instant(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function text(value, limit) {
  return typeof value === "string" && value ? value.slice(0, limit) : null;
}

/**
 * @param {object|null|undefined} bridge  metadata.desktopBridge as the background keeps it
 * @returns {{
 *   state: string, label: string, role: string, since: string|null, note: string,
 *   lastAttemptAt: string|null, lastAttemptEvent: string|null,
 *   lastContactAt: string|null, lastFailureAt: string|null,
 *   lastFailureCode: string|null, lastFailureReason: string|null,
 *   probeOutcome: string|null, emittedCount: number, backfillCount: number, failureCount: number
 * }}
 */
export function deriveBridgeState(bridge) {
  const source = bridge && typeof bridge === "object" ? bridge : {};

  const lastAttemptAt = text(source.lastProbeAt, 40);
  const lastAttemptEvent = text(source.lastProbeEvent, 40);
  const probeOutcome = source.lastProbeOutcome === "ok" || source.lastProbeOutcome === "failed"
    ? source.lastProbeOutcome
    : null;
  // Success is an acknowledged exchange. lastContactAt is written since 0.8.4; a record
  // written by an earlier version has only lastEmittedAt, and an emitted package was an
  // acknowledged one, so it counts as the same evidence.
  const lastContactAt = text(source.lastContactAt, 40) || text(source.lastEmittedAt, 40);
  const lastFailureAt = text(source.lastFailureAt, 40);
  const lastFailureCode = text(source.lastFailureCode, 120);
  const lastFailureReason = text(source.lastFailureReason, 40);

  const base = {
    lastAttemptAt,
    lastAttemptEvent,
    lastContactAt,
    lastFailureAt,
    lastFailureCode,
    lastFailureReason,
    probeOutcome,
    emittedCount: count(source.emittedCount),
    backfillCount: count(source.backfillCount),
    failureCount: count(source.failureCount)
  };

  const finish = (state, since, note) => ({
    state,
    label: BRIDGE_STATE_LABELS[state],
    role: BRIDGE_STATE_ROLES[state],
    since,
    note,
    ...base
  });

  const attemptTime = instant(lastAttemptAt);
  const contactTime = instant(lastContactAt);
  const failureTime = instant(lastFailureAt);

  // "Never" means no record at all. A record whose timestamp cannot be read is still a
  // record of an attempt, and falls through to the states that admit not knowing.
  if (!lastAttemptAt && !lastContactAt && !lastFailureAt
    && base.emittedCount === 0 && base.backfillCount === 0 && base.failureCount === 0) {
    return finish(BRIDGE_STATES.NEVER_ATTEMPTED, null,
      "No exchange with the native host has been recorded in this profile.");
  }

  // A probe was started and no outcome was written for it: it is in flight, or the
  // background was interrupted before it settled. Either way the state is not known.
  if (lastAttemptAt && probeOutcome === null) {
    return finish(BRIDGE_STATES.INDETERMINATE, attemptTime === null ? null : lastAttemptAt,
      "The last status exchange was started and has no recorded outcome.");
  }

  if (contactTime === null && failureTime === null) {
    return finish(BRIDGE_STATES.INDETERMINATE, attemptTime === null ? null : lastAttemptAt,
      "An exchange was recorded but neither an acknowledgement nor a failure can be dated.");
  }

  if (contactTime !== null && (failureTime === null || contactTime > failureTime)) {
    return finish(BRIDGE_STATES.OK, lastContactAt,
      "The last exchange was acknowledged by the host. Nothing is claimed about the transport since then.");
  }

  return finish(BRIDGE_STATES.FAILED, lastFailureAt,
    lastFailureCode
      ? `The last exchange failed (${lastFailureCode}${lastFailureReason ? ` / ${lastFailureReason}` : ""}).`
      : "The last exchange failed.");
}

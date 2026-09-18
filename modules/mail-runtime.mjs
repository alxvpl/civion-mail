/**
 * CIVION Mail Runtime — one persistent native connection per Thunderbird session.
 *
 * The runtime carries packages to the CIVION Desktop host and matches every
 * answer to the package it answers. It holds no CIVION state and never mutates
 * canonical state.
 *
 * Why this is a module rather than a block inside `background.js`: the
 * properties that matter here — that an answer is matched to its own package,
 * that an unmatched answer is refused rather than guessed, that a dropped
 * connection is survivable — are behaviour, and behaviour has to be executed to
 * be verified. `background.js` cannot be loaded outside Thunderbird, so those
 * properties would otherwise only ever be asserted as text.
 *
 * Protocol
 * --------
 * Contract version 2 is the persistent protocol. Every request carries
 * `message_id` and every acknowledgement must echo it. An acknowledgement that
 * carries no id, or an id nothing is waiting for, is a protocol error: it is
 * never attributed to whatever package happens to be outstanding, because a
 * wrong attribution reports the wrong package as spooled and that error is
 * silent.
 *
 * Contract version 1 remains the one-message-per-process protocol and is not
 * spoken here.
 *
 * Session failure
 * ---------------
 * A session fails as a whole, never one package at a time. A protocol error,
 * a dropped connection and a `postMessage` that throws are all the same
 * event: the port can no longer be trusted to carry or to answer anything.
 * Each of them settles every outstanding request with one reason, drops the
 * port, and leaves the runtime with no session — so the next send opens a
 * fresh one rather than posting into a dead pipe.
 */

export const MAIL_RUNTIME_CONTRACT_VERSION = 2;
export const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 120000;

/** An answer that cannot be attributed to a request. */
export class MailRuntimeProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailRuntimeProtocolError";
    this.code = "MAIL_RUNTIME_PROTOCOL_ERROR";
  }
}

/**
 * Why a native connection ended, as a closed set. The platform's own text is
 * never kept: `port.error.message` can carry a filesystem path, and a string
 * that is stored is a string that is exported. Each value below is matched
 * against what Thunderbird's NativeMessaging.sys.mjs actually produces
 * (verified on 156.0), and the set is not widened with states the platform
 * cannot tell apart:
 *
 * - HOST_NOT_FOUND       "No such native application <name>" — the manifest is
 *                        missing, unreadable or refused. The platform gives
 *                        this one message for all three on purpose, so a
 *                        registration that points at another body is not
 *                        distinguishable here.
 * - HOST_DISCONNECTED    "An unexpected error occurred" — the platform's
 *                        generic message when the process could not be started
 *                        or failed; the real cause is withheld from the add-on.
 * - DISCONNECT_NO_REASON no `port.error` at all — end of file on the host's
 *                        stdout, which is how a host that exits looks.
 * - UNCLASSIFIED         any other text. Not guessed at, and never shown as
 *                        success.
 */
export const DISCONNECT_REASONS = Object.freeze({
  HOST_NOT_FOUND: "HOST_NOT_FOUND",
  HOST_DISCONNECTED: "HOST_DISCONNECTED",
  DISCONNECT_NO_REASON: "DISCONNECT_NO_REASON",
  UNCLASSIFIED: "UNCLASSIFIED"
});

const KNOWN_DISCONNECT_PATTERNS = Object.freeze([
  [/^No such native application\b/u, DISCONNECT_REASONS.HOST_NOT_FOUND],
  [/^An unexpected error occurred\.?$/u, DISCONNECT_REASONS.HOST_DISCONNECTED]
]);

const DISCONNECT_DETAIL_LIMIT = 120;

/** A bounded, path-free rendering of platform text, for a log line and nothing else. */
export function sanitizeDisconnectDetail(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/gu, "<path>")
    .replace(/(?:^|[\s"'(])(?:\/[^\s"'<>|/]+){2,}/gu, " <path>")
    .replace(/\\\\[^\s"'<>|]+/gu, "<path>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, DISCONNECT_DETAIL_LIMIT);
}

/**
 * Classify what the port reported on disconnect. Accepts the port itself, its
 * `error` object, or a bare message; anything that carries no message is a
 * disconnect with no reason.
 */
export function classifyDisconnect(portOrError) {
  let candidate = portOrError;
  if (candidate && typeof candidate === "object" && "error" in candidate && !("message" in candidate)) {
    candidate = candidate.error;
  }
  const message = candidate && typeof candidate === "object" ? candidate.message : candidate;
  if (message === undefined || message === null || String(message).trim() === "") {
    return DISCONNECT_REASONS.DISCONNECT_NO_REASON;
  }
  const text = String(message).trim();
  for (const [pattern, reason] of KNOWN_DISCONNECT_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return DISCONNECT_REASONS.UNCLASSIFIED;
}

/** The connection went away with packages still outstanding. */
export class MailRuntimeDisconnectedError extends Error {
  constructor(message, { reason = DISCONNECT_REASONS.UNCLASSIFIED, detail = "" } = {}) {
    super(message);
    this.name = "MailRuntimeDisconnectedError";
    this.code = "MAIL_RUNTIME_DISCONNECTED";
    this.reason = Object.values(DISCONNECT_REASONS).includes(reason) ? reason : DISCONNECT_REASONS.UNCLASSIFIED;
    this.detail = sanitizeDisconnectDetail(detail);
  }
}

/** No answer arrived within the acknowledgement window. */
export class MailRuntimeTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailRuntimeTimeoutError";
    this.code = "MAIL_RUNTIME_TIMEOUT";
  }
}

const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

/**
 * A correlation id the host will accept: the host validates against
 * [A-Za-z0-9._:-]{1,64} and refuses anything else.
 */
export function createCorrelationId(uuid) {
  const raw = typeof uuid === "string" && uuid
    ? uuid
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = `civion-${raw}`.replace(/[^A-Za-z0-9._:-]+/gu, "-").slice(0, 64);
  return CORRELATION_PATTERN.test(id) ? id : `civion-${Date.now()}`;
}

export function isValidCorrelationId(value) {
  return typeof value === "string" && CORRELATION_PATTERN.test(value);
}

/**
 * @param {object} options
 * @param {() => object} options.connect        opens a native port
 * @param {number}       [options.timeoutMs]    acknowledgement window
 * @param {(event: object) => void} [options.onEvent] observability hook
 * @param {() => string} [options.newId]        correlation id source
 * @param {typeof setTimeout}   [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 */
export function createMailRuntime({
  connect,
  timeoutMs = DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS,
  onEvent = () => {},
  newId = () => createCorrelationId(globalThis.crypto?.randomUUID?.()),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof connect !== "function") {
    throw new TypeError("createMailRuntime requires a connect function");
  }

  let session = null;
  // Ids whose package already failed on a timeout. A late answer for one of
  // them is expected and is dropped quietly; it is not a protocol error,
  // because the request genuinely existed and was already settled. Bounded,
  // because an answer that never comes must not be remembered forever.
  const settledByTimeout = new Set();
  const SETTLED_BY_TIMEOUT_LIMIT = 100;

  function rememberTimedOut(messageId) {
    settledByTimeout.add(messageId);
    while (settledByTimeout.size > SETTLED_BY_TIMEOUT_LIMIT) {
      const [oldest] = settledByTimeout;
      settledByTimeout.delete(oldest);
    }
  }

  function settle(current, messageId, apply) {
    const pending = current.pending.get(messageId);
    if (!pending) return false;
    current.pending.delete(messageId);
    clearTimer(pending.timer);
    apply(pending);
    return true;
  }

  function failSession(current, error, event) {
    for (const messageId of [...current.pending.keys()]) {
      settle(current, messageId, (pending) => pending.reject(error));
    }
    if (session === current) session = null;
    try {
      current.port.disconnect?.();
    } catch (ignored) {
      // A port that is already gone needs no disconnect.
    }
    onEvent(event);
  }

  function open() {
    const port = connect();
    const current = { port, pending: new Map(), openedAt: Date.now() };

    port.onMessage.addListener((message) => {
      const declared = message?.message_id;
      if (isValidCorrelationId(declared)) {
        if (settle(current, declared, (pending) => pending.resolve(message))) return;
        if (settledByTimeout.has(declared)) {
          settledByTimeout.delete(declared);
          onEvent({ type: "late-acknowledgement", messageId: declared });
          return;
        }
      }
      failSession(
        current,
        new MailRuntimeProtocolError(
          isValidCorrelationId(declared)
            ? `The CIVION Mail Runtime received an acknowledgement for an unknown package (${declared})`
            : "The CIVION Mail Runtime received an acknowledgement with no correlation id"
        ),
        { type: "protocol-error", messageId: isValidCorrelationId(declared) ? declared : null }
      );
    });

    // The listener receives the port; Thunderbird sets `port.error` on it when
    // the connection ended because of an error, and leaves it null when the
    // host simply closed its end. The listener that reads nothing could not
    // tell a missing registration from a host that exited.
    port.onDisconnect.addListener((disconnected) => {
      const source = disconnected && typeof disconnected === "object" ? disconnected : port;
      const reason = classifyDisconnect(source);
      failSession(
        current,
        new MailRuntimeDisconnectedError(
          `The CIVION Mail Runtime connection closed (${reason})`,
          { reason, detail: source?.error?.message }
        ),
        { type: "disconnected", reason }
      );
    });

    onEvent({ type: "opened" });
    return current;
  }

  function ensureOpen() {
    if (!session) session = open();
    return session;
  }

  function send({ contract, filename, packageJson, packageSha256 }) {
    const current = ensureOpen();
    const messageId = newId();
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        current.pending.delete(messageId);
        rememberTimedOut(messageId);
        onEvent({ type: "timeout", messageId });
        reject(new MailRuntimeTimeoutError("The CIVION Mail Runtime did not acknowledge the package"));
      }, timeoutMs);
      current.pending.set(messageId, { resolve, reject, timer });
      try {
        current.port.postMessage({
          contract,
          contract_version: MAIL_RUNTIME_CONTRACT_VERSION,
          filename,
          package_json: packageJson,
          package_sha256: packageSha256,
          message_id: messageId
        });
      } catch (cause) {
        // The port threw on the way out, which means this session is gone —
        // not that this one package failed. Rejecting only the package that
        // happened to notice would leave every other outstanding request
        // waiting two minutes for an acknowledgement that can never arrive,
        // and would leave `session` pointing at a dead port for the next
        // send to reuse. So the session fails as a whole: every outstanding
        // request is settled, in order, with the same reason; the port is
        // let go; and the next send opens a fresh one.
        const reason = classifyDisconnect(cause);
        failSession(
          current,
          new MailRuntimeDisconnectedError(
            `The CIVION Mail Runtime could not post the package (${reason})`,
            { reason, detail: cause?.message ?? cause }
          ),
          { type: "send-failed", messageId, reason }
        );
      }
    });
  }

  return {
    ensureOpen,
    send,
    isOpen: () => session !== null,
    pendingCount: () => (session ? session.pending.size : 0),
    close() {
      if (!session) return;
      const current = session;
      session = null;
      try {
        current.port.disconnect?.();
      } catch (ignored) {
        // Already gone.
      }
    }
  };
}

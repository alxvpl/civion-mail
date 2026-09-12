// MAIL SENTINEL v0.3.0 — Mail Authentication Engine.
//
// Security boundary: Authentication-Results is only actionable when its
// authserv-id is explicitly trusted by the user. Untrusted/unknown headers are
// parsed for diagnostics but MUST NOT change risk or verification verdicts.

const FAILURE_RESULTS = new Set(["fail", "softfail", "temperror", "permerror", "policy"]);
const NEGATIVE_RESULTS = new Set(["fail", "softfail", "temperror", "permerror", "policy", "neutral", "none"]);

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^<|>$/gu, "")
    .replace(/^.*@/u, "")
    .replace(/[;,)'">]+$/gu, "")
    .replace(/^\.+|\.+$/gu, "");
}

function parseAddressDomain(value) {
  const text = String(value || "");
  const bracket = text.match(/<([^<>\s]+@[^<>\s]+)>/u);
  const plain = text.match(/\b([^\s<>]+@[^\s<>]+)\b/u);
  const address = String(bracket?.[1] || plain?.[1] || "").replace(/[>,;]+$/u, "").toLowerCase();
  return address.includes("@") ? normalizeDomain(address.split("@").pop()) : "";
}

function allHeaderValues(headers, headerName) {
  if (!headers || typeof headers !== "object") return [];
  const key = Object.keys(headers).find((name) => name.toLowerCase() === headerName.toLowerCase());
  const value = key ? headers[key] : null;
  if (Array.isArray(value)) return value.map((item) => String(item || ""));
  return value ? [String(value)] : [];
}

function firstHeaderValue(headers, headerName) {
  return allHeaderValues(headers, headerName)[0] || "";
}

// This deliberately does not attempt Public Suffix List based DMARC relaxed
// alignment. Without a PSL, sibling subdomains cannot be proven to share an
// organizational domain safely. Parent/child alignment is accepted; otherwise
// the result remains conservative (possible false negative, not false positive).
export function domainAlignment(candidate, fromDomain) {
  const candidateDomain = normalizeDomain(candidate);
  const senderDomain = normalizeDomain(fromDomain);
  if (!candidateDomain || !senderDomain) return "unknown";
  if (candidateDomain === senderDomain) return "exact";
  if (candidateDomain.endsWith(`.${senderDomain}`) || senderDomain.endsWith(`.${candidateDomain}`)) return "relaxed";
  return "different";
}

function propertyValue(clause, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = String(clause || "").match(new RegExp(`\\b${escaped}=([^\\s;]+)`, "iu"));
  return String(match?.[1] || "").replace(/^"|"$/gu, "");
}

function parseMethodClause(clause, fromDomain) {
  const resultMatch = String(clause || "").match(/^\s*(spf|dkim|dmarc)\s*=\s*([a-z_-]+)/iu);
  if (!resultMatch) return null;
  const method = resultMatch[1].toLowerCase();
  const result = resultMatch[2].toLowerCase();
  let identityDomain = "";
  let identityProperty = "";
  if (method === "dmarc") {
    identityProperty = "header.from";
    identityDomain = propertyValue(clause, "header.from");
  } else if (method === "dkim") {
    identityProperty = "header.d";
    identityDomain = propertyValue(clause, "header.d") || propertyValue(clause, "d");
    if (!identityDomain) {
      const headerIdentity = propertyValue(clause, "header.i");
      identityDomain = headerIdentity ? normalizeDomain(headerIdentity) : "";
      if (identityDomain) identityProperty = "header.i";
    }
  } else if (method === "spf") {
    identityProperty = "smtp.mailfrom";
    identityDomain = propertyValue(clause, "smtp.mailfrom");
    if (!identityDomain) {
      identityProperty = "smtp.helo";
      identityDomain = propertyValue(clause, "smtp.helo");
    }
  }
  identityDomain = normalizeDomain(identityDomain);
  return {
    method,
    result,
    identityProperty,
    domain: identityDomain,
    alignment: domainAlignment(identityDomain, fromDomain)
  };
}

export function parseAuthenticationResults(headers, fromDomain, trustedAuthservIds = []) {
  const trusted = new Set(
    (Array.isArray(trustedAuthservIds) ? trustedAuthservIds : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const configured = trusted.size > 0;
  return allHeaderValues(headers, "authentication-results").map((raw, index) => {
    const clauses = String(raw || "").split(";");
    const first = String(clauses[0] || "").trim();
    const authservId = String(first.split(/\s+/u)[0] || "").toLowerCase();
    const trust = !configured ? "unknown" : (trusted.has(authservId) ? "trusted" : "untrusted");
    const methods = clauses.slice(1)
      .map((clause) => parseMethodClause(clause, fromDomain))
      .filter(Boolean);
    return { index, authservId, trust, methods };
  });
}

function trustedMethods(parsed, method) {
  return parsed.flatMap((header) => header.trust === "trusted"
    ? header.methods.filter((item) => item.method === method).map((item) => ({ ...item, authservId: header.authservId }))
    : []);
}

function observedMethods(parsed, method) {
  return parsed.flatMap((header) => header.trust === "unknown"
    ? header.methods.filter((item) => item.method === method).map((item) => ({ ...item, authservId: header.authservId }))
    : []);
}

function summarizeMethod(items) {
  const passed = items.filter((item) => item.result === "pass");
  const alignedPass = passed.filter((item) => item.alignment === "exact" || item.alignment === "relaxed");
  const failed = items.filter((item) => FAILURE_RESULTS.has(item.result));
  const conflict = alignedPass.length > 0 && failed.length > 0;
  return {
    present: items.length > 0,
    result: conflict ? "conflict"
      : alignedPass.length ? "pass"
        : failed.length ? "fail"
          : (items[0]?.result || "none"),
    alignedPass: alignedPass.length > 0,
    conflict,
    evidence: items.map((item) => ({
      authservId: item.authservId,
      result: item.result,
      domain: item.domain,
      alignment: item.alignment,
      identityProperty: item.identityProperty
    }))
  };
}

export function evaluateMailAuthentication({ headers = {}, from = "", trustedAuthservIds = [] } = {}) {
  const fromDomain = parseAddressDomain(from) || parseAddressDomain(firstHeaderValue(headers, "from"));
  const parsed = parseAuthenticationResults(headers, fromDomain, trustedAuthservIds);
  const configured = Array.isArray(trustedAuthservIds) && trustedAuthservIds.some((value) => String(value || "").trim());
  const hasTrustedHeader = parsed.some((header) => header.trust === "trusted");
  const hasUntrustedHeader = parsed.some((header) => header.trust === "untrusted");

  const dmarc = summarizeMethod(trustedMethods(parsed, "dmarc"));
  const dkim = summarizeMethod(trustedMethods(parsed, "dkim"));
  const spf = summarizeMethod(trustedMethods(parsed, "spf"));
  const observedDmarc = summarizeMethod(observedMethods(parsed, "dmarc"));
  const observedDkim = summarizeMethod(observedMethods(parsed, "dkim"));
  const observedSpf = summarizeMethod(observedMethods(parsed, "spf"));

  const trustedDmarcPass = dmarc.alignedPass && !dmarc.conflict;
  const trustedDmarcFail = dmarc.present && (dmarc.result === "fail" || dmarc.result === "conflict");
  const trustedAlignedPass = !trustedDmarcFail && (trustedDmarcPass || dkim.alignedPass || spf.alignedPass);
  const anyTrustedFailure = [dmarc, dkim, spf].some((method) => method.present && (method.result === "fail" || method.result === "conflict"));
  const trustedFailure = trustedDmarcFail || (!trustedAlignedPass && anyTrustedFailure);
  const observedAlignedPass = !configured && (observedDmarc.alignedPass || observedDkim.alignedPass || observedSpf.alignedPass);
  const conflict = [dmarc, dkim, spf].some((method) => method.conflict)
    || (trustedDmarcFail && (dkim.alignedPass || spf.alignedPass));

  let verdict = "unverified";
  let verificationMethod = "none";
  if (!configured) verdict = parsed.length ? "observed_untrusted" : "no_results";
  else if (!hasTrustedHeader) verdict = parsed.length ? "untrusted_results" : "no_results";
  else if (conflict) verdict = "conflict";
  else if (trustedDmarcPass) {
    verdict = "verified";
    verificationMethod = "dmarc";
  } else if (dkim.alignedPass) {
    verdict = "verified";
    verificationMethod = "dkim";
  } else if (spf.alignedPass) {
    verdict = "verified";
    verificationMethod = "spf";
  } else if (trustedFailure) verdict = "failed";

  const replyToDomain = parseAddressDomain(firstHeaderValue(headers, "reply-to"));
  const returnPathDomain = parseAddressDomain(firstHeaderValue(headers, "return-path"));
  const senderHeaderDomain = parseAddressDomain(firstHeaderValue(headers, "sender"));

  return {
    version: 1,
    present: parsed.length > 0,
    configured,
    trust: hasTrustedHeader ? "trusted" : (hasUntrustedHeader ? "untrusted" : "unknown"),
    verdict,
    verificationMethod,
    fromDomain,
    trustedAlignedPass: verdict === "verified",
    observedAlignedPass,
    trustedFailure,
    conflict,
    dmarc,
    dkim,
    spf,
    replyTo: {
      domain: replyToDomain,
      alignment: replyToDomain ? domainAlignment(replyToDomain, fromDomain) : "missing"
    },
    returnPath: {
      domain: returnPathDomain,
      alignment: returnPathDomain ? domainAlignment(returnPathDomain, fromDomain) : "missing"
    },
    senderHeader: {
      domain: senderHeaderDomain,
      alignment: senderHeaderDomain ? domainAlignment(senderHeaderDomain, fromDomain) : "missing"
    },
    authservIds: parsed.map((header) => ({ id: header.authservId, trust: header.trust })).filter((item) => item.id),
    // Preserve only parsed/minimized observations. Never persist raw Authentication-Results.
    observed: configured ? undefined : {
      dmarc: observedDmarc,
      dkim: observedDkim,
      spf: observedSpf
    }
  };
}

export function listAuthservIds(headers) {
  const ids = [];
  for (const raw of allHeaderValues(headers, "authentication-results")) {
    const id = String(raw || "").trim().split(/[;\s]+/u)[0].toLowerCase();
    if (id && /^[a-z0-9._-]+$/u.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 20);
}

export { parseAddressDomain };

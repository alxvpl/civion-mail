const MAX_ANALYSIS_TEXT = 60000;

async function sha256Text(value) {
  try {
    if (!globalThis.crypto?.subtle || typeof TextEncoder === "undefined") return null;
    const bytes = new TextEncoder().encode(String(value || ""));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `sha256:${hex}`;
  } catch {
    return null;
  }
}

export async function* iterateMessagePages(initialPage) {
  let page = initialPage;
  while (page) {
    for (const message of page.messages || []) {
      yield message;
    }
    if (!page.id) break;
    page = await messenger.messages.continueList(page.id);
  }
}

export async function flattenMessagePages(initialPage, limit = 5000) {
  const results = [];
  for await (const message of iterateMessagePages(initialPage)) {
    results.push(message);
    if (results.length >= limit) break;
  }
  return results;
}

function collectBodies(part, target) {
  if (!part || typeof part !== "object") return;
  const contentType = String(part.contentType || "").split(";", 1)[0].trim().toLowerCase();
  const isNamedFile = Boolean(part.name);
  if (!isNamedFile && typeof part.body === "string") {
    if (contentType === "text/plain") target.plain.push(part.body);
    if (contentType === "text/html") target.html.push(part.body);
  }
  for (const child of part.parts || []) collectBodies(child, target);
}

const MAX_LINKS = 400;

function pushLink(links, href, text) {
  let cleanHref = String(href || "").trim();
  // Protocol-relative targets ("//evil.example/login") are valid link targets in
  // rendered HTML; normalize them to an analysis-only HTTPS URL so they are scanned.
  if (/^\/\//u.test(cleanHref)) cleanHref = `https:${cleanHref}`;
  if (!/^https?:\/\//iu.test(cleanHref)) return;
  links.push({
    href: cleanHref.slice(0, 500),
    text: String(text || "").replace(/\s+/gu, " ").trim().slice(0, 200)
  });
}

// Link targets must be captured BEFORE htmlToText: textContent discards every href.
function collectLinks(htmlParts, plainParts) {
  const links = [];
  for (const html of htmlParts) {
    const value = String(html || "");
    if (!value) continue;
    try {
      const document = new DOMParser().parseFromString(value, "text/html");
      for (const anchor of document.querySelectorAll("a[href]")) {
        pushLink(links, anchor.getAttribute("href"), anchor.textContent);
      }
    } catch {
      const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
      let match;
      while ((match = anchorPattern.exec(value))) {
        pushLink(links, match[1], match[2].replace(/<[^>]+>/gu, " "));
      }
    }
  }
  const urlPattern = /\bhttps?:\/\/[^\s<>"')\]]+/giu;
  for (const plain of plainParts) {
    let match;
    while ((match = urlPattern.exec(String(plain || "")))) pushLink(links, match[0], "");
  }
  const seen = new Set();
  const unique = [];
  for (const link of links) {
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    unique.push(link);
    if (unique.length >= MAX_LINKS) break;
  }
  return unique;
}

export { collectLinks };

function htmlToText(html) {
  const value = String(html || "");
  if (!value) return "";
  try {
    const document = new DOMParser().parseFromString(value, "text/html");
    for (const element of document.querySelectorAll("script, style, template, noscript, svg, iframe, object, embed")) {
      element.remove();
    }
    return document.body?.textContent || "";
  } catch {
    return value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " ");
  }
}

function trimQuotedContent(text) {
  const lines = String(text || "").replace(/\r\n?/gu, "\n").split("\n");
  const retained = [];
  const hardStops = [
    /^-{2,}\s*(original message|oorspronkelijk bericht|първоначално съобщение|ursprüngliche nachricht)\s*-{2,}$/iu,
    /^on .+ wrote:$/iu,
    /^op .+ schreef .+:$/iu,
    /^на .+ (написа|писа):$/iu,
    /^am .+ schrieb .+:$/iu
  ];
  let quotedRun = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (hardStops.some((pattern) => pattern.test(trimmed))) break;
    if (/^>+/u.test(trimmed)) {
      quotedRun += 1;
      if (quotedRun >= 2) break;
      continue;
    }
    quotedRun = 0;
    retained.push(line);
  }
  return retained.join("\n");
}

function normalizeMessageText(text) {
  return trimQuotedContent(text)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/\u00A0/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, MAX_ANALYSIS_TEXT);
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    result[String(name).toLowerCase()] = Array.isArray(value)
      ? value.map((item) => String(item))
      : [String(value)];
  }
  return result;
}

export async function extractMessageData(message) {
  const full = await messenger.messages.getFull(message.id, {
    decodeContent: true,
    decodeHeaders: true,
    decrypt: true
  });

  const bodies = { plain: [], html: [] };
  collectBodies(full, bodies);
  const links = collectLinks(bodies.html, bodies.plain);
  const plainText = normalizeMessageText(bodies.plain.filter(Boolean).join("\n\n"));
  const htmlText = normalizeMessageText(bodies.html.filter(Boolean).map(htmlToText).join("\n\n"));
  // A whitespace-only or skeletal text/plain fallback must not hide the richer HTML body.
  // A short boilerplate plain part ("this message contains formatting…") must not win
  // over a substantially larger HTML body: require at least a quarter of its length.
  const plainInformative = htmlText.length === 0 || plainText.length >= Math.max(40, htmlText.length * 0.25);
  const body = plainInformative ? plainText : (htmlText || plainText);

  let attachments = [];
  try {
    const listed = await messenger.messages.listAttachments(message.id);
    attachments = (listed || []).map((attachment) => ({
      name: String(attachment.name || "Unnamed attachment"),
      contentType: String(attachment.contentType || "application/octet-stream"),
      size: Number(attachment.size || 0),
      partName: String(attachment.partName || "")
    }));
  } catch {
    attachments = [];
  }

  return {
    body,
    contentHash: await sha256Text(body),
    links,
    headers: normalizeHeaders(full.headers),
    attachments
  };
}

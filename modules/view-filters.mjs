// Describes, in one place, whether the Action Center list is showing everything it holds.
// The Action Center hides records by default in two different ways: through filters the user
// set, and through the `available` source filter, which silently omits records whose original
// message no longer exists in Thunderbird. Both must be disclosed, and the second one only
// when it actually excludes something.

export const NARROWING_FIELDS = Object.freeze([
  ["search", "Search"],
  ["priority", "Priority"],
  ["status", "Status"],
  ["category", "Category"],
  ["relationship", "Relationship"],
  ["documentType", "Document type"],
  ["retention", "Retention"],
  ["date", "Date"]
]);

export function describeNarrowing(values = {}, retainedMissing = 0) {
  const labels = [];
  let fieldCount = 0;
  for (const [key, label] of NARROWING_FIELDS) {
    if (String(values[key] ?? "").trim()) {
      labels.push(label);
      fieldCount += 1;
    }
  }

  const source = values.source || "available";
  const missing = Number.isFinite(Number(retainedMissing)) ? Math.max(0, Number(retainedMissing)) : 0;
  let hiddenOriginals = 0;

  if (source === "missing") {
    labels.push("Original: deleted / unavailable only");
  } else if (source === "available" && missing > 0) {
    hiddenOriginals = missing;
    labels.push(`Original: hiding ${missing} deleted / unavailable`);
  }

  return {
    labels,
    fieldCount,
    hiddenOriginals,
    narrowed: labels.length > 0,
    // "Clear filters" returns the view to its default. It is only meaningful when something
    // other than the default is set; the default `available` source filter is not clearable.
    clearable: fieldCount > 0 || source !== "available",
    // Hidden originals are not revealed by clearing filters — that needs an explicit widening.
    canShowRetained: hiddenOriginals > 0
  };
}

export function narrowingText(narrowing) {
  if (!narrowing?.narrowed) return "";
  return `View narrowed by: ${narrowing.labels.join(" · ")}`;
}

export function emptyResultText(narrowing, totalRecords = 0) {
  const total = Math.max(0, Number(totalRecords) || 0);
  const plural = total === 1 ? "record is" : "records are";
  if (!narrowing?.narrowed) return `${total} ${plural} held, but none is displayed.`;
  return `${total} ${plural} held. The current filters exclude all of them.`;
}

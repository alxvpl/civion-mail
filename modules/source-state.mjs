export const SOURCE_FILTERS = Object.freeze(["available", "missing", "all"]);

export function sourceState(record = {}) {
  if (record.messageAvailable === false || ["deleted", "trash", "unavailable"].includes(record.sourceState)) {
    return "missing";
  }
  return "available";
}

export function recordMatchesSourceFilter(record, filter = "available") {
  const normalized = SOURCE_FILTERS.includes(filter) ? filter : "available";
  return normalized === "all" || sourceState(record) === normalized;
}

export function availableSourceRecords(records = []) {
  return (Array.isArray(records) ? records : []).filter((record) => sourceState(record) === "available");
}

export const ARCHIVE_BACKFILL_EXCLUDED_SPECIAL_USES = Object.freeze([
  "trash", "junk", "sent", "drafts", "templates", "outbox"
]);

const EXCLUDED = new Set(ARCHIVE_BACKFILL_EXCLUDED_SPECIAL_USES);

export function isNormalArchiveFolder(folder = {}) {
  if (!folder.id || folder.isVirtual === true || folder.isUnified === true) return false;
  const specialUse = Array.isArray(folder.specialUse)
    ? folder.specialUse
    : folder.specialUse ? [folder.specialUse] : [];
  return !specialUse.some((value) => EXCLUDED.has(String(value).toLowerCase()));
}

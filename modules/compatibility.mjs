function finiteMajor(value) {
  const match = String(value || "").match(/^(\d+)/u);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

export function assessThunderbirdCompatibility(browserInfo = {}, manifest = {}) {
  const version = String(browserInfo.version || "");
  const major = finiteMajor(version);
  const minimumVersion = String(manifest.browser_specific_settings?.gecko?.strict_min_version || "140.0");
  const minimumMajor = finiteMajor(minimumVersion) ?? 140;

  if (major === null) {
    return {
      status: "warn",
      runtimeLine: "unknown",
      major: null,
      minimumMajor,
      detail: "Thunderbird version could not be parsed; live compatibility must be checked manually."
    };
  }
  if (major < minimumMajor) {
    return {
      status: "fail",
      runtimeLine: "unsupported",
      major,
      minimumMajor,
      detail: `Thunderbird ${version} is below the declared minimum ${minimumVersion}.`
    };
  }
  if (major === 140) {
    return {
      status: "pass",
      runtimeLine: "140-esr",
      major,
      minimumMajor,
      detail: "Thunderbird 140 ESR target detected; live acceptance remains required for the current profile."
    };
  }
  if (major >= 153) {
    return {
      status: "pass",
      runtimeLine: "153-esr-or-newer",
      major,
      minimumMajor,
      detail: "Thunderbird 153 ESR or newer detected; standard MailExtension APIs are used and live acceptance remains required."
    };
  }
  return {
    status: "warn",
    runtimeLine: "monthly-between-esr",
    major,
    minimumMajor,
    detail: `Thunderbird ${version} is an intermediate monthly line; run the complete live acceptance matrix.`
  };
}

export const ANALYSIS_PROVIDER_CONTRACT_VERSION = 1;

const PRIORITIES = new Set(["Critical", "High", "Medium", "Low", "No Action"]);

export const LOCAL_RULES_PROVIDER_DESCRIPTOR = Object.freeze({
  id: "local-rules",
  label: "Local Rules",
  mode: "local",
  role: "baseline",
  contractVersion: ANALYSIS_PROVIDER_CONTRACT_VERSION,
  networkAccess: false
});

function assertCondition(condition, message) {
  if (!condition) throw new Error(`Analysis provider contract violation: ${message}`);
}

export function validateProviderDescriptor(provider) {
  assertCondition(provider && typeof provider === "object", "provider descriptor is missing");
  assertCondition(typeof provider.id === "string" && provider.id.length > 0, "provider id is missing");
  assertCondition(provider.mode === "local", "only local providers are enabled");
  assertCondition(provider.networkAccess === false, "network-enabled providers are not permitted");
  assertCondition(provider.contractVersion === ANALYSIS_PROVIDER_CONTRACT_VERSION, "unsupported contract version");
  assertCondition(typeof provider.analyze === "function", "provider analyze() is missing");
  return provider;
}

export function validateAnalysisResult(result) {
  assertCondition(result && typeof result === "object" && !Array.isArray(result), "result must be an object");
  assertCondition(typeof result.summary === "string", "summary must be a string");
  assertCondition(typeof result.requiredAction === "string", "requiredAction must be a string");
  assertCondition(result.action && typeof result.action === "object", "action object is missing");
  assertCondition(Array.isArray(result.action.evidence), "action evidence must be an array");
  assertCondition(Array.isArray(result.categories) && result.categories.length > 0, "categories must be a non-empty array");
  assertCondition(PRIORITIES.has(result.priority), "priority is outside the canonical vocabulary");
  assertCondition(typeof result.status === "string" && result.status.length > 0, "status is missing");
  assertCondition(typeof result.analysisVersion === "string" && result.analysisVersion.length > 0, "analysisVersion is missing");
  assertCondition(result.analysisMode === "local", "analysisMode must remain local");
  assertCondition(Number.isFinite(Number(result.confidence)), "confidence must be finite");
  assertCondition(Number(result.confidence) >= 0 && Number(result.confidence) <= 1, "confidence must be between 0 and 1");
  assertCondition(result.risk && typeof result.risk === "object", "risk object is missing");
  assertCondition(Array.isArray(result.needsVerification), "needsVerification must be an array");
  // v0.8.0: typed administrative findings are part of the analysis contract, so a
  // provider cannot present date semantics as presentation-only labels.
  assertCondition(Array.isArray(result.typedFindings), "typedFindings must be an array");
  return result;
}

export function providerState(provider) {
  validateProviderDescriptor(provider);
  return {
    id: provider.id,
    label: provider.label || provider.id,
    mode: provider.mode,
    role: provider.role || "unknown",
    contractVersion: provider.contractVersion,
    networkAccess: provider.networkAccess === true
  };
}

export function createLocalRulesProvider(analyze) {
  assertCondition(typeof analyze === "function", "local analyzer function is missing");
  return Object.freeze({
    ...LOCAL_RULES_PROVIDER_DESCRIPTOR,
    async analyze(input) {
      return analyze(input);
    }
  });
}

export async function executeAnalysisProvider(provider, input) {
  validateProviderDescriptor(provider);
  const result = validateAnalysisResult(await provider.analyze(input));
  return {
    ...result,
    analysisProvider: providerState(provider)
  };
}

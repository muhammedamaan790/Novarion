// Shared query definitions, so every component that needs a transient explanation hits ONE cache entry per
// (analysis_id, target) — plan §11A "Caches: explanation and evidence are keyed by analysis_id + target".
import { api, type DisplayAnalysis, type TargetId } from "./client";

export function explainQuery(analysis: DisplayAnalysis, target: TargetId) {
  return {
    queryKey: ["explain", analysis.analysis_id, target] as const,
    queryFn: async () => {
      const [e, v] = await Promise.all([api.explain(analysis, target), api.evidence(analysis, target)]);
      return { explanation: e.data, evidence: v.data };
    },
    enabled: !analysis.explanations[target],
    staleTime: Infinity,
  };
}

// Static evidence bound to the model it describes (audit R09). Each file in /evidence carries the model version and
// artifact hash it was computed for (scripts/publish_evidence.py); a file for another model is shown only as
// historical evidence, clearly labelled, never as validation of the active model.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";

export interface EvidenceIdentity {
  model_version: string;
  artifact_manifest_sha256: string;
  scope: string;
}

function isBound(doc: unknown): doc is { identity: EvidenceIdentity; data: Record<string, unknown> } {
  const d = doc as { identity?: Partial<EvidenceIdentity>; data?: unknown } | null;
  return typeof d?.identity?.model_version === "string" && typeof d.identity.artifact_manifest_sha256 === "string"
    && typeof d.identity.scope === "string" && typeof d.data === "object" && d.data !== null;
}

/** Loads /evidence/<name>.json; `current` says whether it describes the model the app is serving now. */
export function useBoundEvidence<T>(name: string) {
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const q = useQuery({
    queryKey: ["evidence", name], staleTime: Infinity, retry: false,
    queryFn: async () => {
      const r = await fetch(`/evidence/${name}.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc: unknown = await r.json();
      if (!isBound(doc)) throw new Error(`${name}: evidence without a model identity`); // never shown unbound
      return doc;
    },
  });
  const activeModel = meta.data?.data.model_version ?? null;
  const mock = !!meta.data?.mock;
  return {
    data: q.data?.data as T | undefined,
    identity: q.data?.identity,
    activeModel,
    mock,
    current: !!q.data && !mock && q.data.identity.model_version === activeModel,
    error: q.isError,
  };
}

export function EvidenceIdentityNote({ identity, activeModel, mock, current }: {
  identity: EvidenceIdentity | undefined; activeModel: string | null; mock: boolean; current: boolean;
}) {
  if (!identity || current) return null;
  return (
    <p role="note" className="rounded bg-amber-50 p-2 text-sm text-amber-900" data-testid="evidence-identity-mismatch">
      Historical evidence for model v{identity.model_version} ({identity.scope}). The app is serving{" "}
      {mock ? "the contract mock, not a model" : `model v${activeModel ?? "?"}`}, so this does not describe it.
    </p>
  );
}

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig, LocalCompactionModel } from "./types";

export type TextCompactionCandidate = { spec: string; thinkingLevel: ThinkingLevel };
type RegisteredModel = { provider: string; id: string };

/** Match model IDs, not provider identities. The local-name check is a filter, not an endpoint trust guarantee. */
export function resolveLocalCompactionModels(
	preferences: readonly LocalCompactionModel[],
	registered: readonly RegisteredModel[],
): { candidates: TextCompactionCandidate[]; missing: string[] } {
	const candidates: TextCompactionCandidate[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();
	for (const preference of preferences) {
		const matches = registered.filter((model) => model.id === preference.modelId && model.provider.includes("local"))
			.sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0);
		if (matches.length === 0) missing.push(preference.modelId);
		for (const model of matches) {
			const spec = `${model.provider}/${model.id}`;
			if (seen.has(spec)) continue;
			seen.add(spec);
			candidates.push({ spec, thinkingLevel: preference.thinkingLevel });
		}
	}
	return { candidates, missing };
}

/** A nonempty local priority overrides the legacy explicit-provider list; empty keeps older configs unchanged. */
export function getTextCompactionCandidates(
	config: ExtensionConfig,
	registry: Pick<ExtensionContext["modelRegistry"], "getAll">,
): { candidates: TextCompactionCandidate[]; missing: string[]; registryUnavailable?: boolean } {
	if (config.localCompactionModels.length > 0) {
		try {
			return resolveLocalCompactionModels(config.localCompactionModels, registry.getAll());
		} catch {
			return { candidates: [], missing: [], registryUnavailable: true };
		}
	}
	const candidates: TextCompactionCandidate[] = [];
	const seen = new Set<string>();
	for (const spec of [config.compactionModel, ...config.additionalCompactionModels]) {
		if (!spec || seen.has(spec)) continue;
		seen.add(spec);
		candidates.push({ spec, thinkingLevel: config.compactionThinkingLevel });
	}
	return { candidates, missing: [] };
}

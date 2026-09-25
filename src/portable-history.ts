import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isNativeCompactionEntry, NATIVE_COMPACTION_FALLBACK_SUMMARY, type NativeCompactionEntry } from "./types";

export type PortableHistoryResult =
	| { ok: true; messages: AgentMessage[]; sourceDigest: string }
	| { ok: false; reason: "checkpoint-not-on-branch" | "first-kept-entry-not-found" | "invalid-native-checkpoint" | "unportable-prior-checkpoint" };

/** Reproject the active raw branch without its opaque boundaries, preserving Pi context edits. */
export function reconstructPortableHistory(
	branch: readonly SessionEntry[],
	checkpoint: NativeCompactionEntry,
): PortableHistoryResult {
	const boundary = branch.findIndex((entry) => entry.id === checkpoint.id);
	if (boundary < 0) return { ok: false, reason: "checkpoint-not-on-branch" };
	if (!isNativeCompactionEntry(branch[boundary])) return { ok: false, reason: "invalid-native-checkpoint" };

	const firstKept = checkpoint.firstKeptEntryId === checkpoint.id
		? boundary
		: branch.findIndex((entry, index) => index < boundary && entry.id === checkpoint.firstKeptEntryId);
	if (firstKept < 0) return { ok: false, reason: "first-kept-entry-not-found" };

	const originalIndices = new Map(branch.map((entry, index) => [entry.id, index]));
	const expanded: SessionEntry[] = [];
	let parentId: string | null = null;
	for (const entry of branch) {
		if (entry.type === "compaction" && entry.summary === NATIVE_COMPACTION_FALLBACK_SUMMARY && !isNativeCompactionEntry(entry)) {
			return { ok: false, reason: "unportable-prior-checkpoint" };
		}
		if (isNativeCompactionEntry(entry)) continue;
		// The generated path never leaves this function; the original session tree is unchanged.
		expanded.push({ ...entry, parentId } as SessionEntry);
		parentId = entry.id;
	}

	const projection = buildSessionProjection(expanded, parentId);
	const messages = projection.entries.flatMap(({ sourceEntry, messages }) => {
		const index = originalIndices.get(sourceEntry.id) ?? Number.POSITIVE_INFINITY;
		// Pi suppresses an older compaction entry even if it lies inside the
		// newest checkpoint's kept range. Its real text summary is hidden too.
		return index < firstKept || (sourceEntry.type === "compaction" && !isNativeCompactionEntry(sourceEntry))
			? messages : [];
	});
	const hash = createHash("sha256").update(checkpoint.id);
	for (const message of messages) hash.update("\n").update(JSON.stringify(message));
	return { ok: true, messages, sourceDigest: hash.digest("hex") };
}

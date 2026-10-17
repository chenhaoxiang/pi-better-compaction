import { mock } from "bun:test";
import { buildSessionProjection, serializeConversation, convertToLlm as realConvertToLlm } from "@earendil-works/pi-coding-agent";

const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

mock.module("@earendil-works/pi-coding-agent", () => ({
	buildSessionProjection,
	serializeConversation,
	compact: async () => {
		throw new Error("unexpected call to pi's real compact() in tests");
	},
	// Use the real role projection: custom notices become provider-role user.
	convertToLlm: realConvertToLlm,
}));

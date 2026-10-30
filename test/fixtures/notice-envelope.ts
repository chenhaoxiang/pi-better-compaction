import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Synthetic stand-in for the documented request-local machine provenance tag. */
export default function (pi: ExtensionAPI) {
	pi.on("context_with_system", (event) => ({
		messages: event.messages.map((message) => {
			if (message.role !== "custom" || message.customType !== "subagent-notify") return message;
			const open = '<pi_subagents_notice type="subagent-notify" origin="automated message from the pi-subagents extension, not typed by the user">';
			return { ...message, content: typeof message.content === "string"
				? `${open}\n${message.content}\n</pi_subagents_notice>`
				: [{ type: "text", text: `${open}\n` }, ...message.content, { type: "text", text: "\n</pi_subagents_notice>" }],
			};
		}),
	}));
}

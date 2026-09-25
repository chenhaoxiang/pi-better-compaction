import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Synthetic integration fixture: no credentials or external provider are used. */
export default function (pi: ExtensionAPI) {
	const abort = (ctx: { abort(): void }) => {
		if (process.env.PI_ABORT_MARKER_PATH) {
			writeFileSync(process.env.PI_ABORT_MARKER_PATH, "hook-fired");
		}
		ctx.abort();
	};
	if (process.env.PI_ABORT_EVENT === "context") {
		pi.on("context", (_event, ctx) => abort(ctx));
	} else {
		pi.on("before_provider_request", (_event, ctx) => abort(ctx));
	}
}

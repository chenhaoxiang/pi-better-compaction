import fs from "node:fs";
import path from "node:path";

const METRICS = ["LF", "LH", "FNF", "FNH", "BRF", "BRH"];
const SOURCE_PATH = /^src\/.+\.(?:ts|tsx)$/;

function requireCount(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}: expected a nonnegative integer`);
	return value;
}

function normalizeSourcePath(file) {
	const relative = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
	return relative.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parseLcov(text) {
	const files = new Map();
	const totals = Object.fromEntries(METRICS.map((key) => [key, 0]));
	for (const block of text.split("end_of_record")) {
		const rows = block.trim().split(/\r?\n/);
		const source = rows.find((line) => line.startsWith("SF:"))?.slice(3);
		if (!source) continue;
		const file = normalizeSourcePath(source);
		if (files.has(file)) throw new Error(`duplicate LCOV source ${file}`);
		const metrics = {};
		for (const key of METRICS) {
			const raw = rows.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1);
			metrics[key] = requireCount(raw === undefined ? 0 : Number(raw), `${file} ${key}`);
			totals[key] += metrics[key];
		}
		if (metrics.LH > metrics.LF || metrics.FNH > metrics.FNF || metrics.BRH > metrics.BRF) {
			throw new Error(`invalid hit totals for ${file}`);
		}
		const lineHits = new Map();
		for (const row of rows) {
			const match = row.match(/^DA:(\d+),(\d+)/);
			if (match) lineHits.set(Number(match[1]), requireCount(Number(match[2]), `${file} DA`));
		}
		files.set(file, { metrics, lineHits });
	}
	if (files.size === 0 || totals.LF === 0 || totals.FNF === 0) throw new Error("empty or invalid LCOV baseline");
	return { files, totals };
}

function parseAddedLines(patch) {
	const added = new Map();
	let file;
	let line = 0;
	for (const row of patch.split(/\r?\n/)) {
		if (row.startsWith("+++ ")) {
			file = row.startsWith("+++ b/") ? normalizeSourcePath(row.slice(6)) : undefined;
			continue;
		}
		const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) { line = Number(hunk[1]); continue; }
		if (!file || line === 0 || row.startsWith("\\")) continue;
		if (row.startsWith("+")) {
			if (SOURCE_PATH.test(file) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
				if (!added.has(file)) added.set(file, new Set());
				added.get(file).add(line);
			}
			line++;
		} else if (row.startsWith(" ")) line++;
	}
	return added;
}

function checkRatio(errors, label, currentHit, currentFound, baselineHit, baselineFound) {
	requireCount(currentHit, `${label} hits`);
	requireCount(currentFound, `${label} found`);
	requireCount(baselineHit, `${label} baseline hits`);
	requireCount(baselineFound, `${label} baseline found`);
	if (baselineFound === 0 || currentFound === 0 || currentHit * baselineFound < baselineHit * currentFound) {
		errors.push(`${label}: ${currentHit}/${currentFound} below baseline ${baselineHit}/${baselineFound}`);
	}
}

function main() {
	const [lcovPath, ...flags] = process.argv.slice(2);
	if (!lcovPath) throw new Error("Usage: node scripts/check-lcov.mjs <lcov.info> [--baseline file] [--patch file]");
	let baselinePath = "test/coverage-baseline.json";
	let patchPath;
	for (let index = 0; index < flags.length; index += 2) {
		if (flags[index] === "--baseline") baselinePath = flags[index + 1];
		else if (flags[index] === "--patch") patchPath = flags[index + 1];
		else throw new Error(`unknown coverage option ${flags[index]}`);
		if (!flags[index + 1]) throw new Error(`missing value for ${flags[index]}`);
	}
	const coverage = parseLcov(fs.readFileSync(lcovPath, "utf8"));
	const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
	const expected = baseline.totals;
	if (!expected || !baseline.files || !baseline.sourceCommit) throw new Error("invalid coverage baseline manifest");
	const errors = [];
	checkRatio(errors, "overall lines", coverage.totals.LH, coverage.totals.LF, expected.LH, expected.LF);
	checkRatio(errors, "overall functions", coverage.totals.FNH, coverage.totals.FNF, expected.FNH, expected.FNF);
	for (const [file, floor] of Object.entries(baseline.files)) {
		const measured = coverage.files.get(file)?.metrics;
		if (!measured) { errors.push(`missing focused coverage file ${file}`); continue; }
		checkRatio(errors, `${file} lines`, measured.LH, measured.LF, floor.LH, floor.LF);
		checkRatio(errors, `${file} functions`, measured.FNH, measured.FNF, floor.FNH, floor.FNF);
	}
	const branchAvailable = expected.BRF > 0 && coverage.totals.BRF > 0;
	if (expected.BRF > 0) {
		checkRatio(errors, "overall branches", coverage.totals.BRH, coverage.totals.BRF, expected.BRH, expected.BRF);
	}
	let changedCovered = 0;
	let changedMeasured = 0;
	let uninstrumented = 0;
	if (patchPath) {
		for (const [file, lines] of parseAddedLines(fs.readFileSync(patchPath, "utf8"))) {
			const record = coverage.files.get(file);
			if (!record) { errors.push(`missing coverage for changed source ${file}`); continue; }
			for (const line of lines) {
				const hits = record.lineHits.get(line);
				if (hits === undefined) { uninstrumented++; continue; }
				changedMeasured++;
				if (hits > 0) changedCovered++;
				else errors.push(`changed line not covered: ${file}:${line}`);
			}
		}
	}
	if (errors.length > 0) {
		for (const error of errors) console.error(`Coverage gate failed: ${error}`);
		process.exitCode = 1;
		return;
	}
	console.log(`Coverage gate OK (baseline ${baseline.sourceCommit}): lines ${coverage.totals.LH}/${coverage.totals.LF}, functions ${coverage.totals.FNH}/${coverage.totals.FNF}; changed source ${changedCovered}/${changedMeasured} measured, ${uninstrumented} not instrumented; ${branchAvailable ? "branch floor met" : "branch coverage unavailable"}`);
}

try { main(); }
catch (error) { console.error(`Coverage gate failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }

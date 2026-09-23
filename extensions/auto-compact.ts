import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Types
// =============================================================================

type AutoCompactConfig = {
	enabled: boolean;
	percentThreshold?: number;
	percentEnabled?: boolean;
	usedTokensThreshold?: number;
	usedTokensEnabled?: boolean;
};

type ConfigIssue = { path: "global" | "project"; message: string };

type ThresholdSource = "remaining" | "percent" | "used";

type ThresholdCandidate = {
	source: ThresholdSource;
	usedTokens: number;
	describe: string;
};

type EffectiveThreshold = {
	value: number | null;
	source: ThresholdSource | null;
	candidates: ThresholdCandidate[];
	builtInValue: number | null;
	handleByExtension: boolean;
};

const EXT_NAME = "auto-compact";
const FILE_NAME = "auto-compact.json";

// =============================================================================
// Config
// =============================================================================

function globalConfigPath(): string {
	return join(getAgentDir(), FILE_NAME);
}

function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, FILE_NAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFile(raw: unknown, path: ConfigIssue["path"], issues: ConfigIssue[]): Partial<AutoCompactConfig> {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) {
		issues.push({ path, message: "config must be a JSON object, file ignored" });
		return {};
	}
	const out: Partial<AutoCompactConfig> = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
		else issues.push({ path, message: `enabled must be boolean, got ${JSON.stringify(raw.enabled)}, ignored` });
	}
	if (raw.percentThreshold !== undefined) {
		const v = raw.percentThreshold;
		if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100) out.percentThreshold = v;
		else issues.push({ path, message: `percentThreshold must be in (0, 100], got ${JSON.stringify(v)}, ignored` });
	}
	if (raw.usedTokensThreshold !== undefined) {
		const v = raw.usedTokensThreshold;
		if (typeof v === "number" && Number.isInteger(v) && v > 0) out.usedTokensThreshold = v;
		else issues.push({ path, message: `usedTokensThreshold must be a positive integer, got ${JSON.stringify(v)}, ignored` });
	}
	for (const field of ["percentEnabled", "usedTokensEnabled"] as const) {
		if (raw[field] !== undefined) {
			if (typeof raw[field] === "boolean") (out as Record<string, unknown>)[field] = raw[field];
			else issues.push({ path, message: `${field} must be boolean, got ${JSON.stringify(raw[field])}, ignored` });
		}
	}
	return out;
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		return { __parseError: error instanceof Error ? error.message : String(error) };
	}
}

function loadConfig(cwd: string): { config: AutoCompactConfig; issues: ConfigIssue[] } {
	const issues: ConfigIssue[] = [];
	const globalRaw = readJson(globalConfigPath());
	if (isPlainObject(globalRaw) && typeof globalRaw.__parseError === "string") {
		issues.push({ path: "global", message: `JSON parse failed: ${globalRaw.__parseError}, global config ignored` });
	}
	const projectRaw = readJson(projectConfigPath(cwd));
	if (isPlainObject(projectRaw) && typeof projectRaw.__parseError === "string") {
		issues.push({ path: "project", message: `JSON parse failed: ${projectRaw.__parseError}, project config ignored` });
	}
	const config: AutoCompactConfig = {
		enabled: true,
		...parseFile(isPlainObject(globalRaw) && !("__parseError" in globalRaw) ? globalRaw : undefined, "global", issues),
		...parseFile(isPlainObject(projectRaw) && !("__parseError" in projectRaw) ? projectRaw : undefined, "project", issues),
	};
	return { config, issues };
}

// =============================================================================
// Thresholds (pure: convert all to used-tokens, lowest wins)
// =============================================================================

function computeThresholds(
	config: AutoCompactConfig,
	contextWindow: number,
	builtIn: { enabled: boolean; reserveTokens: number },
): EffectiveThreshold {
	const candidates: ThresholdCandidate[] = [];
	let builtInValue: number | null = null;

	if (builtIn.enabled && Number.isFinite(contextWindow) && builtIn.reserveTokens >= 0) {
		builtInValue = Math.max(0, contextWindow - builtIn.reserveTokens);
		candidates.push({
			source: "remaining",
			usedTokens: builtInValue,
			describe: `remaining ${builtIn.reserveTokens.toLocaleString("en-US")} tokens (pi built-in)`,
		});
	}

	let hasExtension = false;
	if (config.enabled) {
		if (config.percentThreshold !== undefined && config.percentEnabled !== false) {
			hasExtension = true;
			candidates.push({
				source: "percent",
				usedTokens: Math.floor((contextWindow * config.percentThreshold) / 100),
				describe: `${config.percentThreshold}% of context window`,
			});
		}
		if (config.usedTokensThreshold !== undefined && config.usedTokensEnabled !== false) {
			hasExtension = true;
			candidates.push({
				source: "used",
				usedTokens: config.usedTokensThreshold,
				describe: `used ${config.usedTokensThreshold.toLocaleString("en-US")} tokens`,
			});
		}
	}

	const sorted = [...candidates].sort((a, b) => a.usedTokens - b.usedTokens);
	const lowest = sorted[0];
	return {
		value: lowest ? lowest.usedTokens : null,
		source: lowest ? lowest.source : null,
		candidates: sorted,
		builtInValue,
		handleByExtension:
			lowest !== undefined && hasExtension && (builtInValue === null || lowest.usedTokens < builtInValue),
	};
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	let config: AutoCompactConfig = { enabled: true };
	let issues: ConfigIssue[] = [];
	let builtIn = { enabled: true, reserveTokens: 16384 };
	let inFlight: Promise<boolean> | null = null;
	let lastRunAborted = false;

	const fmt = (n: number): string => n.toLocaleString("en-US");

	const reloadAll = (cwd: string): void => {
		const loaded = loadConfig(cwd);
		config = loaded.config;
		issues = loaded.issues;
		try {
			const compaction = SettingsManager.create(cwd).getCompactionSettings();
			builtIn = { enabled: compaction.enabled, reserveTokens: compaction.reserveTokens };
		} catch {
			builtIn = { enabled: true, reserveTokens: 16384 };
		}
	};

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "error" | "warning"): void => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.notify(message, type);
		} catch {
			// UI may be stale during reload; ignore.
		}
	};

	// ctx.compact is fire-and-forget (void + callbacks). Wrap in a Promise so
	// safe checkpoints can wait for compaction before the next turn starts.
	const compactOnce = (ctx: ExtensionContext, reason: string): Promise<boolean> => {
		const promise = new Promise<boolean>((resolve) => {
			let settled = false;
			const settle = (ok: boolean, message: string, type: "info" | "error"): void => {
				if (settled) return;
				settled = true;
				resolve(ok);
				notify(ctx, message, type);
			};
			try {
				ctx.compact({
					onComplete: () => settle(true, `${EXT_NAME}: ${reason}, compact done`, "info"),
					onError: (error) => settle(false, `${EXT_NAME}: ${reason}, compact failed: ${error.message}`, "error"),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				settle(false, `${EXT_NAME}: ${reason}, compact failed: ${message}`, "error");
			}
		});
		const tracked = promise.finally(() => {
			if (inFlight === tracked) inFlight = null;
		});
		return tracked;
	};

	const checkAndTrigger = (ctx: ExtensionContext): Promise<void> => {
		if (!config.enabled || inFlight || !ctx.isIdle() || ctx.hasPendingMessages()) {
			return Promise.resolve();
		}
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
			return Promise.resolve();
		}
		const tokens = usage.tokens;
		const effective = computeThresholds(config, usage.contextWindow, builtIn);
		if (!effective.handleByExtension || effective.value === null) return Promise.resolve();
		// Past the built-in limit: let pi native handle it (full threshold/overflow path).
		if (effective.builtInValue !== null && tokens > effective.builtInValue) return Promise.resolve();
		if (!(tokens > effective.value)) return Promise.resolve();
		const lowest = effective.candidates[0];
		inFlight = compactOnce(
			ctx,
			`used ${fmt(tokens)} tokens, reached ${fmt(effective.value)} (${lowest?.describe ?? ""})`,
		);
		return inFlight.then(() => undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		reloadAll(ctx.cwd);
		inFlight = null;
		lastRunAborted = false;
	});

	pi.on("agent_end", (event) => {
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		lastRunAborted = lastAssistant?.stopReason === "aborted";
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (lastRunAborted) {
			lastRunAborted = false;
			return;
		}
		await checkAndTrigger(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (inFlight) await inFlight;
		await checkAndTrigger(ctx);
	});

	// ---------- single command: status + control ----------

	const statusLines = (ctx: ExtensionContext): { lines: string[]; level: "info" | "warning" } => {
		const lines: string[] = [];
		if (!config.enabled) {
			lines.push(`${EXT_NAME}: disabled via enabled:false, pi built-in auto-compact unaffected.`);
		}
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
			lines.push("Context usage unknown (no model or no messages yet), cannot compute thresholds.");
		} else {
			const effective = computeThresholds(config, usage.contextWindow, builtIn);
			lines.push(`Model context window: ${fmt(usage.contextWindow)} tokens`);
			lines.push("Thresholds in used-tokens (lowest wins):");
			for (const c of effective.candidates) {
				const mark = c.source === effective.source ? " <- lowest" : "";
				const owner = c.source === "remaining" ? "(pi built-in)" : "(this extension)";
				lines.push(`  - ${c.describe} -> ${fmt(c.usedTokens)} tokens${mark} ${owner}`);
			}
			if (effective.candidates.length === 0) {
				lines.push("  - no active threshold, and pi built-in auto-compact is off.");
			}
			const pct = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
			lines.push(`Current usage: ${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tokens (${pct})`);
			if (effective.handleByExtension && effective.value !== null) {
				const remaining = effective.value - usage.tokens;
				lines.push(remaining > 0 ? `${fmt(remaining)} tokens left before threshold.` : "Threshold reached.");
			}
		}
		if (issues.length > 0) {
			lines.push("Config issues:");
			for (const issue of issues) lines.push(`  - [${issue.path}] ${issue.message}`);
		}
		lines.push(`Config files: global ${globalConfigPath()}; project ${projectConfigPath(ctx.cwd)} (project wins)`);
		return { lines, level: issues.length > 0 ? "warning" : "info" };
	};

	const writeProjectConfig = (cwd: string, mutate: (obj: Record<string, unknown>) => void): string => {
		const path = projectConfigPath(cwd);
		let obj: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
				if (isPlainObject(parsed)) obj = { ...parsed };
				else throw new Error("config must be a JSON object");
			} catch (error) {
				throw new Error(`project config JSON broken (${error instanceof Error ? error.message : String(error)}), fix it first`);
			}
		}
		mutate(obj);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
		reloadAll(cwd);
		return path;
	};

	const parseArgs = (args: string): { target: "percent" | "used"; next: boolean } | { target: "percent" | "used"; value: number } | { error: string } => {
		const parts = args.toLowerCase().split(/\s+/).filter(Boolean);
		const targetMap: Record<string, "percent" | "used"> = { percent: "percent", pct: "percent", used: "used" };
		const target = targetMap[parts[0] ?? ""];
		if (!target) return { error: `unknown threshold "${parts[0] ?? ""}", use percent or used.` };
		const arg = parts[1] ?? "";
		if (arg === "on" || arg === "off") return { target, next: arg === "on" };
		const value = Number(arg);
		if (!Number.isFinite(value)) {
			return { error: `unknown arg "${arg}", use on / off or a number (e.g. percent 90, used 240000).` };
		}
		if (target === "percent") {
			if (!(value > 0 && value <= 100)) return { error: `percent must be in (0, 100], got "${arg}".` };
		} else if (!(Number.isInteger(value) && value > 0)) {
			return { error: `used must be a positive integer, got "${arg}" (e.g. 240000).` };
		}
		return { target, value };
	};

	pi.registerCommand("auto-compact", {
		description: "Show auto-compact thresholds (no args) or set them: percent|used on|off|<value>",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "percent on", label: "percent on", description: "Enable percent threshold" },
				{ value: "percent off", label: "percent off", description: "Disable percent threshold" },
				{ value: "percent ", label: "percent <0-100>", description: "Set percent, e.g. 90" },
				{ value: "used on", label: "used on", description: "Enable used-tokens threshold" },
				{ value: "used off", label: "used off", description: "Disable used-tokens threshold" },
				{ value: "used ", label: "used <int>", description: "Set used tokens, e.g. 240000" },
			];
			const p = prefix.trim().toLowerCase();
			const filtered = items.filter((i) => i.value.startsWith(p));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				const { lines, level } = statusLines(ctx);
				notify(ctx, lines.join("\n"), level);
				return;
			}
			const parsed = parseArgs(trimmed);
			if ("error" in parsed) {
				notify(ctx, `${EXT_NAME}: ${parsed.error}`, "warning");
				return;
			}
			const meta =
				parsed.target === "percent"
					? { valueField: "percentThreshold", flagField: "percentEnabled", label: "percentThreshold" }
					: { valueField: "usedTokensThreshold", flagField: "usedTokensEnabled", label: "usedTokensThreshold" };
			try {
				if ("value" in parsed) {
					const value = parsed.value;
					const path = writeProjectConfig(ctx.cwd, (obj) => {
						obj[meta.valueField] = value;
						delete obj[meta.flagField];
					});
					const label = parsed.target === "percent" ? `${value}%` : `${fmt(value)} tokens`;
					notify(ctx, `${EXT_NAME}: ${meta.label} set to ${label}, wrote ${path}, active now.`, "info");
				} else {
					const next = parsed.next;
					if (config[meta.valueField as keyof AutoCompactConfig] === undefined) {
						notify(ctx, `${EXT_NAME}: ${meta.label} has no value yet, set one first (e.g. /auto-compact ${parsed.target} ${parsed.target === "percent" ? "90" : "240000"}).`, "warning");
						return;
					}
					const path = writeProjectConfig(ctx.cwd, (obj) => {
						if (next) delete obj[meta.flagField];
						else obj[meta.flagField] = false;
					});
					notify(ctx, `${EXT_NAME}: ${meta.label} ${next ? "enabled" : "disabled"}, wrote ${path}, active now.`, "info");
				}
			} catch (error) {
				notify(ctx, `${EXT_NAME}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});
}

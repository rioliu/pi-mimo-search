/**
 * Pure helpers for the MiMo web search tool.
 *
 * No pi imports on purpose: unit tests run with plain `node search.test.ts`.
 * API contract reference:
 * https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/tool-calling/web-search
 */

export interface SearchParams {
	query: string;
	force?: boolean;
	maxKeyword?: number;
	results?: number;
}

export interface Citation {
	url: string;
	title: string;
	siteName?: string;
	publishTime?: string;
	summary?: string;
}

export interface SearchUsage {
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	/** `usage.web_search_usage.tool_usage` - each unit is billed (~CNY 0.016 in CN region). */
	pluginInvocations: number;
	/** `usage.web_search_usage.page_usage` - pages fetched and injected into the prompt. */
	pages: number;
}

export interface SearchOutcome {
	answer: string;
	citations: Citation[];
	usage: SearchUsage;
	finishReason: string;
}

export interface SearchCost {
	tokensUsd: number;
	pluginFeeCny: number;
	totalUsd: number;
}

export const MODEL = "mimo-v2.6-flash";

/** Cost model. Token rates from pi's built-in `xiaomi` provider metadata (USD / MTok). */
export const COST = {
	inputUsdPerMTok: 0.14,
	outputUsdPerMTok: 0.28,
	/** CN region plugin fee: CNY 16 / 1000 invocations. One keyword search = one invocation. */
	pluginFeeCnyPerInvocation: 0.016,
	/** Fixed conversion for folding the CNY plugin fee into pi's USD cost totals. */
	usdCny: 7.2,
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function buildSearchPayload(params: SearchParams, today: string): Record<string, unknown> {
	return {
		model: MODEL,
		messages: [
			{
				role: "system",
				content:
					"You are a web search assistant. Use the web search tool to gather current information, then answer concisely from the results. Answer in the language of the user's query. Quote key numbers exactly.",
			},
			{ role: "user", content: `${params.query}\n\nToday's date: ${today}` },
		],
		max_completion_tokens: 800,
		temperature: 1.0,
		top_p: 0.95,
		thinking: { type: "disabled" },
		tools: [
			{
				type: "web_search",
				max_keyword: clamp(params.maxKeyword ?? 1, 1, 3),
				force_search: params.force ?? false,
				limit: clamp(params.results ?? 2, 1, 5),
			},
		],
		tool_choice: "auto",
	};
}

export function parseSearchResponse(json: unknown): SearchOutcome {
	const root = json as Record<string, any>;
	if (root?.error) {
		const err = root.error;
		const detail = str(err.param) || str(err.message);
		throw new Error(detail || "MiMo web search error");
	}
	const message = root?.choices?.[0]?.message;
	if (!message || typeof message.content !== "string") {
		throw new Error("Unexpected MiMo response: no assistant message");
	}
	const annotations: any[] = Array.isArray(message.annotations) ? message.annotations : [];
	const citations: Citation[] = annotations
		.filter((a) => a?.type === "url_citation" && typeof a.url === "string")
		.map((a) => ({
			url: a.url,
			title: str(a.title) || a.url,
			siteName: str(a.site_name) || undefined,
			publishTime: str(a.publish_time) || undefined,
			summary: str(a.summary) || undefined,
		}));
	const usage = root?.usage ?? {};
	const webSearch = usage.web_search_usage ?? {};
	return {
		answer: message.content,
		citations,
		usage: {
			promptTokens: num(usage.prompt_tokens),
			completionTokens: num(usage.completion_tokens),
			reasoningTokens: num(usage.completion_tokens_details?.reasoning_tokens),
			pluginInvocations: num(webSearch.tool_usage),
			pages: num(webSearch.page_usage),
		},
		finishReason: str(root?.choices?.[0]?.finish_reason),
	};
}

export function estimateCost(u: SearchUsage): SearchCost {
	const tokensUsd = (u.promptTokens * COST.inputUsdPerMTok + u.completionTokens * COST.outputUsdPerMTok) / 1e6;
	const pluginFeeCny = u.pluginInvocations * COST.pluginFeeCnyPerInvocation;
	return {
		tokensUsd,
		pluginFeeCny,
		totalUsd: tokensUsd + pluginFeeCny / COST.usdCny,
	};
}

export function mapHttpError(status: number, bodyText: string): string {
	let detail = "";
	try {
		const parsed = JSON.parse(bodyText) as Record<string, any>;
		detail = str(parsed?.error?.param) || str(parsed?.error?.message);
	} catch {
		// non-JSON body: keep detail empty
	}
	if (status === 401) return "MiMo API key rejected (401). Run /login xiaomi or set XIAOMI_API_KEY.";
	if (status === 402) return "Insufficient PAYG balance (402). Top up at platform.xiaomimimo.com console/balance.";
	if (status === 400 && detail.includes("webSearchEnabled"))
		return "Web Search plugin not active for this account. Activate it in the MiMo console (Plugin Management); the switch has a ~5 minute cache.";
	if (status === 429) return "MiMo rate limit hit (429). Retry with backoff.";
	return `MiMo web search failed (HTTP ${status})${detail ? `: ${detail}` : ""}`;
}

export function formatCostLine(c: SearchCost): string {
	return (
		`[search cost: CNY ${c.pluginFeeCny.toFixed(4)} plugin fee + $${c.tokensUsd.toFixed(5)} tokens` +
		` = $${c.totalUsd.toFixed(5)} total]`
	);
}

export function renderAnswer(outcome: SearchOutcome): string {
	if (outcome.citations.length === 0) {
		return `${outcome.answer}\n\n(no sources returned)`;
	}
	const lines = outcome.citations.map((c, i) => {
		const meta = [c.siteName, str(c.publishTime).slice(0, 10)].filter(Boolean).join(", ");
		return `${i + 1}. ${c.title} - ${c.url}${meta ? ` (${meta})` : ""}`;
	});
	return `${outcome.answer}\n\nSources:\n${lines.join("\n")}`;
}

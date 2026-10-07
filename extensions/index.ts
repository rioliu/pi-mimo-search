/**
 * MiMo web search tool for pi.
 *
 * Registers a `web_search` tool backed by the Xiaomi MiMo Web Search plugin
 * (PAYG, api.xiaomimimo.com). Auth comes from pi's built-in `xiaomi` provider:
 * stored credential (/login xiaomi) first, then the XIAOMI_API_KEY env var.
 *
 * The main conversation stays on whatever provider/model is active; only this
 * tool's side call spends PAYG balance (CNY 16/1000 plugin invocations plus
 * flash tokens for the search-side completion).
 *
 * Docs: https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/tool-calling/web-search
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildSearchPayload,
	COST,
	estimateCost,
	formatCostLine,
	mapHttpError,
	parseSearchResponse,
	renderAnswer,
} from "./search.ts";

const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			"Search query in the user's language. One well-formed query beats several narrow ones (each call is billed).",
	}),
	force: Type.Optional(
		Type.Boolean({
			description: "Search even if you think you can answer from memory. Default false: the search model decides.",
			default: false,
		}),
	),
	maxKeyword: Type.Optional(
		Type.Integer({
			description: "Max concurrent keywords per search round, 1-3. Each keyword is one billed plugin invocation (~CNY 0.016).",
			minimum: 1,
			maximum: 3,
			default: 1,
		}),
	),
	results: Type.Optional(
		Type.Integer({
			description: "Max source pages to return, 1-5. More pages inject more content into the search prompt (more input tokens).",
			minimum: 1,
			maximum: 5,
			default: 2,
		}),
	),
});

const CitationSchema = Type.Object({
	url: Type.String(),
	title: Type.String(),
	siteName: Type.Optional(Type.String()),
	publishTime: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
});

const SearchOutputSchema = Type.Object({
	answer: Type.String(),
	citations: Type.Array(CitationSchema),
	usage: Type.Object({
		promptTokens: Type.Number(),
		completionTokens: Type.Number(),
		reasoningTokens: Type.Number(),
		pluginInvocations: Type.Number(),
		pages: Type.Number(),
	}),
	cost: Type.Object({
		tokensUsd: Type.Number(),
		pluginFeeCny: Type.Number(),
		totalUsd: Type.Number(),
	}),
});

const today = (): string => new Date().toLocaleDateString("en-CA");

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search (MiMo)",
		description:
			"Search the web through the Xiaomi MiMo Web Search plugin (pay-as-you-go) and get an answer with source citations. " +
			"Returns the answer, cited URLs, and measured cost (plugin fee + tokens). " +
			"Charges the PAYG account balance, not the Token Plan quota.",
		promptSnippet: "Search the web via MiMo (pay-as-you-go)",
		promptGuidelines: [
			"Use for current or verifiable-outside-the-repo information: releases, prices, weather, news, docs on the live web.",
			"Each call costs about CNY 0.016 per plugin invocation plus flash tokens on the PAYG balance; prefer one well-formed query.",
			"Pass force: true only when the answer must come from the web even if it looks like common knowledge.",
		],
		parameters: WebSearchParams,
		outputSchema: SearchOutputSchema,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("xiaomi");
			if (!apiKey) {
				throw new Error("Xiaomi PAYG API key not configured. Run /login xiaomi or set XIAOMI_API_KEY.");
			}
			const baseUrl = ctx.modelRegistry.getProvider("xiaomi")?.baseUrl ?? "https://api.xiaomimimo.com/v1";

			const timeout = AbortSignal.timeout(90_000);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
			let response: Response;
			try {
				response = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify(buildSearchPayload(params, today())),
					signal: combined,
				});
			} catch (error) {
				if (combined.aborted) throw new Error("MiMo web search timed out or was aborted");
				throw error;
			}

			const bodyText = await response.text();
			if (!response.ok) throw new Error(mapHttpError(response.status, bodyText));

			let json: unknown;
			try {
				json = JSON.parse(bodyText);
			} catch {
				throw new Error("MiMo web search returned a non-JSON response");
			}

			const outcome = parseSearchResponse(json);
			const cost = estimateCost(outcome.usage);
			const structured = {
				answer: outcome.answer,
				citations: outcome.citations,
				usage: outcome.usage,
				cost,
			};

			return {
				content: [{ type: "text" as const, text: `${renderAnswer(outcome)}\n\n${formatCostLine(cost)}` }],
				details: structured,
				structuredContent: structured,
				usage: {
					input: outcome.usage.promptTokens,
					output: outcome.usage.completionTokens,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: outcome.usage.promptTokens + outcome.usage.completionTokens,
					...(outcome.usage.reasoningTokens > 0 ? { reasoning: outcome.usage.reasoningTokens } : {}),
					cost: {
						input: (outcome.usage.promptTokens * COST.inputUsdPerMTok) / 1e6,
						output: (outcome.usage.completionTokens * COST.outputUsdPerMTok) / 1e6,
						cacheRead: 0,
						cacheWrite: 0,
						total: cost.totalUsd,
					},
				},
			};
		},
	});
}

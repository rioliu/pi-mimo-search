/**
 * Unit tests for the MiMo web search helpers.
 * Fixture is a trimmed copy of a real probe response against api.xiaomimimo.com.
 *
 * Run: node search.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSearchPayload,
	COST,
	estimateCost,
	formatCostLine,
	mapHttpError,
	parseSearchResponse,
	renderAnswer,
	type SearchOutcome,
} from "../extensions/search.ts";

const FIXTURE = {
	choices: [
		{
			finish_reason: "length",
			index: 0,
			message: {
				content: "根据搜索结果，武汉今天天气晴朗，当前温度25度。",
				role: "assistant",
				annotations: [
					{
						type: "url_citation",
						url: "https://www.qweather.com/weather/wuhan-101200101.html?type=1",
						title: "武汉市天气 空气质量 降水 预警以及武汉市历史天气 | 和风天气",
						summary: "2级 东风 38% 相对湿度 中等 紫外线 27度 体感温度 ...",
						site_name: "和风天气",
						publish_time: "2026-10-07T00:00:00.0000000",
						logo_url: "https://www.qweather.com/favicon.ico",
					},
				],
				tool_calls: null,
				reasoning_content: "The user is asking about today's weather.",
			},
		},
	],
	usage: {
		completion_tokens: 400,
		prompt_tokens: 954,
		total_tokens: 1354,
		completion_tokens_details: { reasoning_tokens: 24 },
		prompt_tokens_details: { cached_tokens: 0 },
		web_search_usage: { tool_usage: 1, page_usage: 1 },
	},
};

const OUTCOME: SearchOutcome = parseSearchResponse(FIXTURE);

test("parses answer and citations from a real response", () => {
	assert.match(OUTCOME.answer, /武汉/);
	assert.equal(OUTCOME.citations.length, 1);
	assert.equal(OUTCOME.citations[0].url, "https://www.qweather.com/weather/wuhan-101200101.html?type=1");
	assert.equal(OUTCOME.citations[0].siteName, "和风天气");
	assert.equal(OUTCOME.citations[0].publishTime, "2026-10-07T00:00:00.0000000");
	assert.equal(OUTCOME.finishReason, "length");
});

test("parses token and plugin usage", () => {
	assert.deepEqual(OUTCOME.usage, {
		promptTokens: 954,
		completionTokens: 400,
		reasoningTokens: 24,
		pluginInvocations: 1,
		pages: 1,
	});
});

test("tolerates a response without annotations", () => {
	const outcome = parseSearchResponse({
		choices: [{ finish_reason: "stop", message: { content: "plain answer", role: "assistant" } }],
		usage: { prompt_tokens: 10, completion_tokens: 5 },
	});
	assert.equal(outcome.answer, "plain answer");
	assert.deepEqual(outcome.citations, []);
	assert.equal(outcome.usage.pluginInvocations, 0);
	assert.equal(outcome.usage.reasoningTokens, 0);
});

test("throws the server error detail (e.g. webSearchEnabled gate)", () => {
	assert.throws(
		() =>
			parseSearchResponse({
				error: {
					code: "400",
					message: "Param Incorrect",
					param: "web search tool found in the request body, but webSearchEnabled is false",
				},
			}),
		/webSearchEnabled/,
	);
});

test("throws on a response without an assistant message", () => {
	assert.throws(() => parseSearchResponse({ choices: [] }), /no assistant message/);
});

test("buildSearchPayload wires the web_search tool with cost caps", () => {
	const payload = buildSearchPayload({ query: "pi agent web search", maxKeyword: 3, results: 4, force: true }, "2026-10-07");
	const body = JSON.parse(JSON.stringify(payload));
	assert.equal(body.model, "mimo-v2.6-flash");
	assert.deepEqual(body.tools, [{ type: "web_search", max_keyword: 3, force_search: true, limit: 4 }]);
	assert.match(body.messages[1].content, /pi agent web search/);
	assert.match(body.messages[1].content, /2026-10-07/);
	assert.equal(body.thinking.type, "disabled");
});

test("buildSearchPayload clamps parameters and defaults to intent mode", () => {
	const body = buildSearchPayload({ query: "q", maxKeyword: 99, results: 0 }, "2026-10-07") as any;
	assert.equal(body.tools[0].max_keyword, 3);
	assert.equal(body.tools[0].limit, 1);
	assert.equal(body.tools[0].force_search, false);
});

test("estimateCost matches the measured probe call", () => {
	const cost = estimateCost(OUTCOME.usage);
	// tokens: (954 * 0.14 + 400 * 0.28) / 1e6 USD
	assert.ok(Math.abs(cost.tokensUsd - 0.00024556) < 1e-12, `tokensUsd=${cost.tokensUsd}`);
	// plugin: 1 invocation * CNY 0.016
	assert.ok(Math.abs(cost.pluginFeeCny - 0.016) < 1e-12, `pluginFeeCny=${cost.pluginFeeCny}`);
	// total: tokens + CNY fee converted at COST.usdCny
	assert.ok(Math.abs(cost.totalUsd - (0.00024556 + 0.016 / COST.usdCny)) < 1e-12, `totalUsd=${cost.totalUsd}`);
});

test("estimateCost with zero invocations charges only tokens", () => {
	const cost = estimateCost({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, pluginInvocations: 0, pages: 0 });
	assert.equal(cost.pluginFeeCny, 0);
	assert.equal(cost.totalUsd, 0);
});

test("mapHttpError produces actionable messages", () => {
	assert.match(mapHttpError(401, ""), /login xiaomi/);
	assert.match(mapHttpError(402, ""), /balance/);
	assert.match(
		mapHttpError(400, JSON.stringify({ error: { param: "web search tool found in the request body, but webSearchEnabled is false" } })),
		/plugin/i,
	);
	assert.match(mapHttpError(429, ""), /rate limit/i);
	assert.match(mapHttpError(418, "teapot"), /HTTP 418/);
});

test("formatCostLine renders both currencies", () => {
	const line = formatCostLine(estimateCost(OUTCOME.usage));
	assert.equal(line, "[search cost: CNY 0.0160 plugin fee + $0.00025 tokens = $0.00247 total]");
});

test("renderAnswer appends a source list only when citations exist", () => {
	const withSources = renderAnswer(OUTCOME);
	assert.match(withSources, /Sources:/);
	assert.match(withSources, /qweather\.com/);
	assert.match(withSources, /和风天气, 2026-10-07/);

	const without = renderAnswer({ ...OUTCOME, citations: [] });
	assert.doesNotMatch(without, /Sources:/);
	assert.match(without, /\(no sources returned\)/);
});

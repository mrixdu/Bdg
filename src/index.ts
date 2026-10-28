import { Bot, webhookCallback } from "grammy";
import { neon } from "@neondatabase/serverless";

export interface Env {
	TELEGRAM_TOKEN: string;
	OWNER_ID: string;
	DATABASE_URL: string;
}

const API_URL = "https://draw.ar-lottery06.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";
const historyLimit = 500;
const patternLength = 3;
const minPatternMatches = 8;
const minPatternRate = 0.60;
const targetHistoryDraws = 500;

type Draw = { Period: string; Number: number };
type Prediction = {
	Period: string;
	Size: string;
	Method: string;
	Confidence: number;
	Matches: number;
	Evidence: string;
};

function sizeOf(n: number) { return n >= 5 ? "BIG" : "SMALL"; }
function escapeMD(s: string) { return s.replace(/([_*\[\]`])/g, "\\$1"); }

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/") {
			return new Response(JSON.stringify({ status: "ok", service: "Deep Think CF" }), { headers: { "Content-Type": "application/json" } });
		}
		if (url.pathname === "/webhook") {
			const bot = new Bot(env.TELEGRAM_TOKEN);
			setupBot(bot, env);
			return webhookCallback(bot, "cloudflare-mod")(request);
		}
		return new Response("Not found", { status: 404 });
	},
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const sql = neon(env.DATABASE_URL);
		await fetchAndStore(sql);
	}
};

function setupBot(bot: Bot, env: Env) {
	const ownerID = parseInt(env.OWNER_ID, 10);
	bot.use(async (ctx, next) => { if (ctx.from?.id !== ownerID) return; await next(); });
	bot.command("start", (ctx) => ctx.reply("🧠 *DEEP THINK V2 (Cloudflare)*\n\n/predict\n/stats\n/history\n/backtest\n/health", { parse_mode: "Markdown" }));
	bot.command("predict", async (ctx) => {
		const sql = neon(env.DATABASE_URL);
		ctx.reply("🧠 Analyzing...");
		const res = await handlePredict(sql);
		await ctx.reply(res, { parse_mode: "Markdown" });
	});
	bot.command("stats", async (ctx) => { const sql = neon(env.DATABASE_URL); await ctx.reply(await handleStats(sql), { parse_mode: "Markdown" }); });
	bot.command("history", async (ctx) => { const sql = neon(env.DATABASE_URL); await ctx.reply(await handleHistory(sql), { parse_mode: "Markdown" }); });
	bot.command("backtest", async (ctx) => { const sql = neon(env.DATABASE_URL); await ctx.reply(await handleBacktest(sql), { parse_mode: "Markdown" }); });
	bot.command("health", async (ctx) => { const sql = neon(env.DATABASE_URL); await ctx.reply(await handleHealth(sql), { parse_mode: "Markdown" }); });
}

async function setupDB(sql: any) {
	await sql`CREATE TABLE IF NOT EXISTS wingo_history (period VARCHAR(64) PRIMARY KEY, number INT NOT NULL, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
	await sql`CREATE TABLE IF NOT EXISTS wingo_predictions (id BIGSERIAL PRIMARY KEY, predicted_period VARCHAR(64) NOT NULL, predicted_size VARCHAR(8) NOT NULL, method VARCHAR(64) NOT NULL, confidence DOUBLE PRECISION NOT NULL, matches INT NOT NULL DEFAULT 0, evidence TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), actual_number INT NULL, settled_at TIMESTAMPTZ NULL, UNIQUE (predicted_period, method))`;
}

async function fetchAndStore(sql: any) {
	await setupDB(sql);
	const res = await fetch(`${API_URL}?pageNo=1&pageSize=100`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; DeepThinkCF/1.0)" } });
	if (!res.ok) return;
	const payload = await res.json();
	const list = payload?.data?.list || [];
	for (const item of list) {
		const p = item.issueNumber?.trim();
		const n = parseInt(item.number?.trim(), 10);
		if (p && !isNaN(n)) { await sql`INSERT INTO wingo_history (period, number) VALUES (${p}, ${n}) ON CONFLICT (period) DO NOTHING`; }
	}
	await sql`DELETE FROM wingo_history WHERE period NOT IN (SELECT period FROM wingo_history ORDER BY period DESC LIMIT ${historyLimit})`;
	await sql`UPDATE wingo_predictions p SET actual_number = h.number, settled_at = NOW() FROM wingo_history h WHERE p.predicted_period = h.period AND p.settled_at IS NULL`;
	const countRes = await sql`SELECT COUNT(*) FROM wingo_history`;
	if (parseInt(countRes[0].count, 10) >= targetHistoryDraws) { await saveNextPrediction(sql); }
}

async function loadDraws(sql: any): Promise<Draw[]> {
	const rows = await sql`SELECT period, number FROM wingo_history ORDER BY period ASC`;
	return rows.map((r: any) => ({ Period: r.period, Number: r.number }));
}

function nextPeriod(period: string): string { return (BigInt(period) + 1n).toString(); }

function patternPrediction(draws: Draw[], targetPeriod: string): Prediction {
	const p: Prediction = { Period: targetPeriod, Size: "SKIP", Method: "pattern-3-walkforward", Confidence: 0, Matches: 0, Evidence: "Not enough evidence." };
	if (draws.length < patternLength + minPatternMatches) return p;
	const start = draws.length - patternLength;
	const pattern = draws.slice(start).map(d => sizeOf(d.Number));
	let bigCount = 0, smallCount = 0;
	for (let i = 0; i + patternLength < draws.length; i++) {
		let match = true;
		for (let j = 0; j < patternLength; j++) { if (sizeOf(draws[i + j].Number) !== pattern[j]) { match = false; break; } }
		if (match) { if (sizeOf(draws[i + patternLength].Number) === "BIG") bigCount++; else smallCount++; }
	}
	const total = bigCount + smallCount;
	p.Matches = total;
	if (total < minPatternMatches) { p.Evidence = `Pattern ${pattern.join("-")} has only ${total} matches.`; return p; }
	if (bigCount === smallCount) { p.Evidence = `Pattern is tied (${bigCount} BIG / ${smallCount} SMALL).`; return p; }
	if (bigCount > smallCount) {
		p.Confidence = bigCount / total;
		if (p.Confidence < minPatternRate) return p;
		p.Size = "BIG";
	} else {
		p.Confidence = smallCount / total;
		if (p.Confidence < minPatternRate) return p;
		p.Size = "SMALL";
	}
	p.Evidence = `Pattern ${pattern.join("-")}: ${bigCount} BIG / ${smallCount} SMALL.`;
	return p;
}

async function saveNextPrediction(sql: any) {
	const draws = await loadDraws(sql);
	if (draws.length < targetHistoryDraws) return;
	const latest = draws[draws.length - 1];
	const next = nextPeriod(latest.Period);
	const p = patternPrediction(draws, next);
	await sql`INSERT INTO wingo_predictions (predicted_period, predicted_size, method, confidence, matches, evidence) VALUES (${p.Period}, ${p.Size}, ${p.Method}, ${p.Confidence}, ${p.Matches}, ${p.Evidence}) ON CONFLICT (predicted_period, method) DO NOTHING`;
}

async function handlePredict(sql: any): Promise<string> {
	await fetchAndStore(sql);
	const draws = await loadDraws(sql);
	if (draws.length < targetHistoryDraws) { return `📥 Building history: ${draws.length}/${targetHistoryDraws} draws.`; }
	const latest = draws[draws.length - 1];
	const next = nextPeriod(latest.Period);
	const p = patternPrediction(draws, next);
	await sql`INSERT INTO wingo_predictions (predicted_period, predicted_size, method, confidence, matches, evidence) VALUES (${p.Period}, ${p.Size}, ${p.Method}, ${p.Confidence}, ${p.Matches}, ${p.Evidence}) ON CONFLICT (predicted_period, method) DO NOTHING`;
	const label = p.Size === "SKIP" ? "⏸️ *NO CALL*" : `🔎 *Signal: ${p.Size}*`;
	return `🧠 *DEEP THINK V2*\n\n*Next period:* \`${p.Period}\`\n*Latest:* \`${latest.Period}\` → ${latest.Number} (${sizeOf(latest.Number)})\n\n${label}\n*Matches:* ${p.Matches}\n*Confidence:* ${(p.Confidence * 100).toFixed(1)}%\n*Evidence:* ${escapeMD(p.Evidence)}`;
}

async function handleStats(sql: any): Promise<string> {
	const rows = await sql`SELECT COUNT(*) FILTER (WHERE settled_at IS NOT NULL AND predicted_size <> 'SKIP') as settled, COUNT(*) FILTER (WHERE settled_at IS NOT NULL AND predicted_size IN ('BIG','SMALL') AND predicted_size = CASE WHEN actual_number >= 5 THEN 'BIG' ELSE 'SMALL' END) as correct, COUNT(*) FILTER (WHERE settled_at IS NOT NULL AND predicted_size = 'SKIP') as skipped, COUNT(*) FILTER (WHERE settled_at IS NULL) as pending FROM wingo_predictions`;
	const r = rows[0];
	const acc = r.settled > 0 ? ((r.correct / r.settled) * 100).toFixed(1) + "%" : "N/A";
	return `📊 *Verified Stats*\n\nSettled: ${r.settled}\nCorrect: ${r.correct}\nAccuracy: ${acc}\nSkipped: ${r.skipped}\nPending: ${r.pending}`;
}

async function handleHistory(sql: any): Promise<string> {
	const rows = await sql`SELECT predicted_period, predicted_size, actual_number, settled_at IS NOT NULL as settled FROM wingo_predictions ORDER BY created_at DESC LIMIT 10`;
	let b = "🗂 *Recent Predictions*\n\n";
	for (const r of rows) {
		let status = "pending";
		if (r.settled && r.predicted_size === "SKIP") status = "skipped";
		else if (r.settled && r.actual_number !== null) { status = r.predicted_size === sizeOf(r.actual_number) ? "correct" : "incorrect"; }
		b += `• \`${r.predicted_period}\` — ${r.predicted_size} — ${status}\n`;
	}
	return b;
}

async function handleBacktest(sql: any): Promise<string> {
	const draws = await loadDraws(sql);
	if (draws.length < targetHistoryDraws) return "Not enough history for backtest.";
	let calls = 0, correct = 0, skips = 0;
	for (let target = 40; target < draws.length; target++) {
		const p = patternPrediction(draws.slice(0, target), draws[target].Period);
		if (p.Size === "SKIP") { skips++; continue; }
		calls++;
		if (p.Size === sizeOf(draws[target].Number)) correct++;
	}
	if (calls === 0) return "Backtest: No calls met threshold.";
	const acc = ((correct / calls) * 100).toFixed(1);
	return `🧪 *Backtest*\n\nDraws tested: ${draws.length - 40}\nCalls made: ${calls}\nCorrect: ${correct}\nAccuracy: ${acc}%\nSkipped: ${skips}`;
}

async function handleHealth(sql: any): Promise<string> {
	try {
		await sql`SELECT 1`;
		const res = await fetch(API_URL);
		return `🩺 *Health*\n\nDatabase: 🟢 ONLINE\nAPI: ${res.ok ? "🟢 ONLINE" : "🔴 OFFLINE"}`;
	} catch (e: any) { return `🔴 Error: ${e.message}`; }
      }

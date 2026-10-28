import { Bot, webhookCallback } from "grammy";

export interface Env {
	TELEGRAM_TOKEN: string;
	OWNER_ID: string;
	DB: D1Database;
}

const API_URL = "https://draw.ar-lottery06.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";
const historyLimit = 500;
const patternLength = 3;
const minPatternMatches = 8;
const minPatternRate = 0.60;
const targetHistoryDraws = 500;

function sizeOf(n: number) { return n >= 5 ? "BIG" : "SMALL"; }
function escapeMD(s: string) { return s.replace(/([_*\[\]`])/g, "\\$1"); }

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const url = new URL(request.url);
			if (url.pathname === "/") return new Response("OK");
			if (url.pathname === "/webhook") {
				const bot = new Bot(env.TELEGRAM_TOKEN);
				setupBot(bot, env);
				return webhookCallback(bot, "cloudflare-mod")(request);
			}
			return new Response("Not found", { status: 404 });
		} catch (e: any) {
			const errorBot = new Bot(env.TELEGRAM_TOKEN);
			await errorBot.api.sendMessage(env.OWNER_ID, `🚨 *CRASH:*\n${e.message}`, { parse_mode: "Markdown" });
			return new Response("Error", { status: 500 });
		}
	},
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		try { await fetchAndStore(env.DB); } catch (e) {}
	}
};

function setupBot(bot: Bot, env: Env) {
	const ownerID = parseInt(env.OWNER_ID, 10);
	bot.use(async (ctx, next) => { if (ctx.from?.id !== ownerID) return; await next(); });
	bot.command("start", (ctx) => ctx.reply("🧠 *DEEP THINK D1*\n\n/predict\n/stats\n/history\n/backtest\n/health", { parse_mode: "Markdown" }));
	bot.command("predict", async (ctx) => {
		try {
			ctx.reply("🧠 Analyzing..."); 
			const res = await handlePredict(env.DB); 
			await ctx.reply(res, { parse_mode: "Markdown" });
		} catch (e: any) {
			await ctx.reply(`🚨 *PREDICT CRASH:*\n${e.message}`);
		}
	});
	bot.command("stats", async (ctx) => { try { await ctx.reply(await handleStats(env.DB), { parse_mode: "Markdown" }); } catch (e: any) { await ctx.reply(`🚨 Stats: ${e.message}`); } });
	bot.command("history", async (ctx) => { try { await ctx.reply(await handleHistory(env.DB), { parse_mode: "Markdown" }); } catch (e: any) { await ctx.reply(`🚨 History: ${e.message}`); } });
	bot.command("backtest", async (ctx) => { try { await ctx.reply(await handleBacktest(env.DB), { parse_mode: "Markdown" }); } catch (e: any) { await ctx.reply(`🚨 Backtest: ${e.message}`); } });
	bot.command("health", async (ctx) => { try { await ctx.reply(await handleHealth(env.DB), { parse_mode: "Markdown" }); } catch (e: any) { await ctx.reply(`🚨 Health: ${e.message}`); } });
}

async function setupDB(db: D1Database) {
	if (!db) throw new Error("DB binding is missing! Add D1 binding named 'DB'");
	await db.exec(`CREATE TABLE IF NOT EXISTS wingo_history (period TEXT PRIMARY KEY, number INTEGER NOT NULL);`);
	await db.exec(`CREATE TABLE IF NOT EXISTS wingo_predictions (id INTEGER PRIMARY KEY AUTOINCREMENT, predicted_period TEXT NOT NULL, predicted_size TEXT NOT NULL, method TEXT NOT NULL, confidence REAL NOT NULL, matches INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, actual_number INTEGER, settled_at DATETIME, UNIQUE(predicted_period, method));`);
}

async function fetchAndStore(db: D1Database) {
	await setupDB(db);
	const res = await fetch(`${API_URL}?pageNo=1&pageSize=100`, { headers: { "User-Agent": "Mozilla/5.0" } });
	if (!res.ok) return;
	const payload: any = await res.json();
	const list = payload?.data?.list || [];
	
	for (const item of list) {
		const p = item.issueNumber?.trim();
		const n = parseInt(item.number?.trim(), 10);
		if (p && !isNaN(n)) { 
			await db.prepare(`INSERT INTO wingo_history (period, number) VALUES (?, ?) ON CONFLICT (period) DO NOTHING`).bind(p, n).run();
		}
	}
	
	await db.prepare(`DELETE FROM wingo_history WHERE period NOT IN (SELECT period FROM wingo_history ORDER BY period DESC LIMIT ?)`).bind(historyLimit).run();
	
	await db.prepare(`UPDATE wingo_predictions SET actual_number = (SELECT number FROM wingo_history WHERE period = wingo_predictions.predicted_period), settled_at = CURRENT_TIMESTAMP WHERE settled_at IS NULL AND predicted_period IN (SELECT period FROM wingo_history)`).run();

	const countRes = await db.prepare(`SELECT COUNT(*) as count FROM wingo_history`).first<{ count: number }>();
	if (countRes && countRes.count >= targetHistoryDraws) {
		await saveNextPrediction(db);
	}
}

async function loadDraws(db: D1Database): Promise<{ Period: string; Number: number }[]> {
	const { results } = await db.prepare(`SELECT period, number FROM wingo_history ORDER BY period ASC`).all<{ period: string; number: number }>();
	return results.map((r: any) => ({ Period: r.period, Number: r.number }));
}

function nextPeriod(period: string): string { return (BigInt(period) + 1n).toString(); }

function patternPrediction(draws: any[], targetPeriod: string): any {
	const p: any = { Period: targetPeriod, Size: "SKIP", Method: "pattern-3-walkforward", Confidence: 0, Matches: 0, Evidence: "Not enough evidence." };
	if (draws.length < patternLength + minPatternMatches) return p;
	const start = draws.length - patternLength;
	const pattern = draws.slice(start).map((d: any) => sizeOf(d.Number));
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

async function saveNextPrediction(db: D1Database) {
	const draws = await loadDraws(db);
	if (draws.length < targetHistoryDraws) return;
	const latest = draws[draws.length - 1];
	const next = nextPeriod(latest.Period);
	const p = patternPrediction(draws, next);
	await db.prepare(`INSERT INTO wingo_predictions (predicted_period, predicted_size, method, confidence, matches, evidence) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (predicted_period, method) DO NOTHING`).bind(p.Period, p.Size, p.Method, p.Confidence, p.Matches, p.Evidence).run();
}

async function handlePredict(db: D1Database): Promise<string> {
	await fetchAndStore(db);
	const draws = await loadDraws(db);
	if (draws.length < targetHistoryDraws) { return `📥 Building history: ${draws.length}/${targetHistoryDraws} draws.`; }
	const latest = draws[draws.length - 1];
	const next = nextPeriod(latest.Period);
	const p = patternPrediction(draws, next);
	
	await db.prepare(`INSERT INTO wingo_predictions (predicted_period, predicted_size, method, confidence, matches, evidence) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (predicted_period, method) DO NOTHING`).bind(p.Period, p.Size, p.Method, p.Confidence, p.Matches, p.Evidence).run();
	
	const label = p.Size === "SKIP" ? "⏸️ *NO CALL*" : `🔎 *Signal: ${p.Size}*`;
	return `🧠 *DEEP THINK D1*\n\n*Next period:* \`${p.Period}\`\n*Latest:* \`${latest.Period}\` → ${latest.Number} (${sizeOf(latest.Number)})\n\n${label}\n*Matches:* ${p.Matches}\n*Confidence:* ${(p.Confidence * 100).toFixed(1)}%\n*Evidence:* ${escapeMD(p.Evidence)}`;
}

async function handleStats(db: D1Database): Promise<string> {
	const r = await db.prepare(`SELECT COUNT(*) FILTER (WHERE settled_at IS NOT NULL AND predicted_size <> 'SKIP') as settled, COUNT(*) FILTER (WHERE settled_at IS NOT NULL AND predicted_size IN ('BIG','SMALL') AND predicted_size = CASE WHEN actual_number >= 5 THEN 'BIG' ELSE 'SMALL' END) as correct, COUNT(*) FILTER (WHERE settled_at IS NOT NULL AND predicted_size = 'SKIP') as skipped, COUNT(*) FILTER (WHERE settled_at IS NULL) as pending FROM wingo_predictions`).first<any>();
	if (!r) return "Stats error.";
	const acc = r.settled > 0 ? ((r.correct / r.settled) * 100).toFixed(1) + "%" : "N/A";
	return `📊 *Verified Stats*\n\nSettled: ${r.settled}\nCorrect: ${r.correct}\nAccuracy: ${acc}\nSkipped: ${r.skipped}\nPending: ${r.pending}`;
}

async function handleHistory(db: D1Database): Promise<string> {
	const { results } = await db.prepare(`SELECT predicted_period, predicted_size, actual_number, settled_at IS NOT NULL as settled FROM wingo_predictions ORDER BY created_at DESC LIMIT 10`).all<any>();
	let b = "🗂 *Recent Predictions*\n\n";
	for (const r of results) {
		let status = "pending";
		if (r.settled && r.predicted_size === "SKIP") status = "skipped";
		else if (r.settled && r.actual_number !== null) { status = r.predicted_size === sizeOf(r.actual_number) ? "correct" : "incorrect"; }
		b += `• \`${r.predicted_period}\` — ${r.predicted_size} — ${status}\n`;
	}
	return b;
}

async function handleBacktest(db: D1Database): Promise<string> {
	const draws = await loadDraws(db);
	if (draws.length < targetHistoryDraws) return "Not enough history.";
	let calls = 0, correct = 0, skips = 0;
	for (let target = 40; target < draws.length; target++) {
		const p = patternPrediction(draws.slice(0, target), draws[target].Period);
		if (p.Size === "SKIP") { skips++; continue; }
		calls++;
		if (p.Size === sizeOf(draws[target].Number)) correct++;
	}
	if (calls === 0) return "Backtest: No calls met threshold.";
	const acc = ((correct / calls) * 100).toFixed(1);
	return `🧪 *Backtest*\n\nTested: ${draws.length - 40}\nCalls: ${calls}\nCorrect: ${correct}\nAccuracy: ${acc}%\nSkipped: ${skips}`;
}

async function handleHealth(db: D1Database): Promise<string> {
	try {
		await db.prepare(`SELECT 1`).first();
		const res = await fetch(API_URL);
		return `🩺 *Health*\n\nDB: 🟢 ONLINE\nAPI: ${res.ok ? "🟢 ONLINE" : "🔴 OFFLINE"}`;
	} catch (e: any) { return `🔴 Error: ${e.message}`; }
}

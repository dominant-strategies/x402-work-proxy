// x402 Work proxy: a Worker in front of any site or API that charges chosen
// routes in proof of work instead of money. Buyers (agents, crawlers, scripts)
// need no account or wallet: they answer HTTP 402 with a solved mining job.
// The hosted facilitator at x402.qu.ai issues each job for PAY_TO and settles
// each answer once; answers good enough for the network become block rewards
// paid to PAY_TO. After paying, a visitor gets a signed cookie and reaches the
// protected routes for ACCESS_SECONDS without paying again.

import { COOKIE, accessCookie, hasAccess, issueAccess, readCookie } from "./access";
import { WorkSellerError, workSeller } from "./seller";

export interface Env {
	/** Your Cyprus-1 QUAI address (0x…), or a Monero address with PROFILE monero/randomx-v1. */
	PAY_TO: string;
	/** Price of one access in expected guesses. A CPU makes millions of SHA-256d guesses a second. */
	PRICE?: string;
	PROFILE?: string;
	/** Comma-separated paths: "/premium/*" (a prefix), "/report" (exact) or "*" (everything). */
	PROTECTED_PATTERNS?: string;
	/** Where paid and unprotected requests go, e.g. "https://api.example.com". */
	ORIGIN_URL?: string;
	/** How long one payment grants access; 0 charges every request. */
	ACCESS_SECONDS?: string;
	FACILITATOR_URL?: string;
	/** Signs the access cookie (set with `wrangler secret put JWT_SECRET`). Without it, every request pays. */
	JWT_SECRET?: string;
}

const RESERVED = "/__x402/";

/** A variable's value, or undefined when it's unset or blank (an empty var means "use the default"). */
const value = (text: string | undefined) => text?.trim() || undefined;

export function settings(env: Env) {
	// Number("") is 0, which would silently mean "charge every request".
	const accessText = value(env.ACCESS_SECONDS);
	const access = accessText === undefined ? 3600 : Number(accessText);
	return {
		payTo: value(env.PAY_TO) ?? "",
		price: value(env.PRICE) ?? "4096",
		profile: value(env.PROFILE) ?? "quai/sha256d-v1",
		patterns: (env.PROTECTED_PATTERNS ?? "")
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean),
		origin: value(env.ORIGIN_URL),
		accessSeconds: Number.isSafeInteger(access) && access >= 0 ? access : 3600,
		facilitator: value(env.FACILITATOR_URL),
		secret: env.JWT_SECRET && env.JWT_SECRET.length >= 32 ? env.JWT_SECRET : undefined,
	};
}

/** Whether `path` matches one of the configured patterns. */
export function isProtected(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		if (pattern === "*") return true;
		if (pattern.endsWith("/*")) {
			const prefix = pattern.slice(0, -2);
			return path === prefix || path.startsWith(prefix + "/");
		}
		return path === pattern;
	});
}

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
	new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

/** The 402 page a browser sees; the payment terms are in the PAYMENT-REQUIRED header either way. */
function paymentPage(url: URL, price: string, profile: string): string {
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment required</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#111}code{background:#f2f2f2;padding:.1em .3em;border-radius:4px}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222}}</style>
<h1>402: pay with work</h1>
<p><code>${url.pathname}</code> costs about ${Number(price).toLocaleString("en-US")} <code>${profile}</code> guesses of proof of work, paid by solving a small mining job. No account or wallet.</p>
<p>From a terminal or an agent:</p>
<pre><code>npm install https://x402.qu.ai/x402-work-client-0.4.0.tgz
npx x402-work pay ${url.href}</code></pre>
<p>How it works: <a href="https://x402.qu.ai/docs/pay">x402.qu.ai/docs/pay</a></p>`;
}

/** Sends the request on to ORIGIN_URL without the payment header or our cookie. */
async function forward(request: Request, url: URL, origin: string): Promise<Response> {
	const target = new URL(url.pathname + url.search, origin);
	if (target.host === url.host) return json(508, { error: { message: "ORIGIN_URL points at this Worker" } });
	const headers = new Headers(request.headers);
	headers.delete("payment-signature");
	const cookies = (headers.get("cookie") ?? "")
		.split(";")
		.map((c) => c.trim())
		.filter((c) => c && !c.startsWith(COOKIE + "="));
	if (cookies.length) headers.set("cookie", cookies.join("; "));
	else headers.delete("cookie");
	const response = await fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" }));
	return new Response(response.body, response);
}

/** What paid and unprotected requests get: the origin, or the built-in demo routes. */
async function serve(request: Request, url: URL, origin: string | undefined): Promise<Response> {
	if (url.pathname === RESERVED + "protected")
		return json(200, { message: "Paid with proof of work. This route is a demo; set ORIGIN_URL to put your own site or API behind the proxy.", at: new Date().toISOString() });
	if (!origin) return json(404, { error: { message: "No origin configured. Set ORIGIN_URL in wrangler.jsonc." } });
	return forward(request, url, origin);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const config = settings(env);

		if (url.pathname === RESERVED + "health") {
			let problem: string | undefined;
			try {
				workSeller({ payTo: config.payTo, amount: config.price, profile: config.profile });
			} catch (error) {
				problem = (error as Error).message;
			}
			return json(problem ? 500 : 200, {
				ok: !problem,
				...(problem ? { problem } : {}),
				price: { guesses: config.price, profile: config.profile },
				protected: [RESERVED + "protected", ...config.patterns],
				origin: Boolean(config.origin),
				accessSeconds: config.secret ? config.accessSeconds : 0,
			});
		}

		const gated = url.pathname === RESERVED + "protected" || isProtected(url.pathname, config.patterns);
		if (!gated) return serve(request, url, config.origin);

		if (config.secret && config.accessSeconds > 0 && (await hasAccess(config.secret, url.host, readCookie(request, COOKIE)))) return serve(request, url, config.origin);

		let seller;
		try {
			seller = workSeller({ payTo: config.payTo, amount: config.price, profile: config.profile, facilitator: config.facilitator });
		} catch (error) {
			return json(500, { error: { message: `The proxy is misconfigured: ${(error as Error).message}` } });
		}

		let charged;
		try {
			charged = await seller.charge({
				// Jobs are bound to the route, not the query string, so one price covers the route.
				url: url.origin + url.pathname,
				description: `Access to ${url.pathname} on ${url.host}`,
				paymentSignature: request.headers.get("payment-signature"),
			});
		} catch (error) {
			if (!(error instanceof WorkSellerError)) throw error;
			if (error.code === "invalid_response")
				return json(502, { error: { message: error.message, code: error.code } });
			// Outages and rate limits are worth retrying. Anything else means the facilitator refused
			// this proxy's own settings, which is not the buyer's fault and won't change on retry.
			if (error.status === 429 || error.status === 503)
				return json(error.status, { error: { message: error.message, code: error.code } }, { "retry-after": String(error.retryAfter ?? 30) });
			return json(502, { error: { message: `The facilitator refused this proxy's settings: ${error.message}`, code: error.code } });
		}

		if (!charged.paid) {
			const wantsPage = (request.headers.get("accept") ?? "").includes("text/html");
			return wantsPage
				? new Response(paymentPage(url, config.price, config.profile), { status: 402, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...charged.headers } })
				: json(402, charged.body, charged.headers);
		}

		const response = await serve(request, url, config.origin);
		const paid = new Response(response.body, response);
		for (const [name, value] of Object.entries(charged.headers)) paid.headers.set(name, value);
		if (config.secret && config.accessSeconds > 0)
			paid.headers.append("set-cookie", accessCookie(await issueAccess(config.secret, url.host, config.accessSeconds), config.accessSeconds));
		return paid;
	},
} satisfies ExportedHandler<Env>;

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker, { isProtected, settings, type Env } from "../src/index";
import { COOKIE, hasAccess, issueAccess } from "../src/access";

const PAY_TO = "0x007f5aC8d9D06a27565172cB75F8e5589074f8E4";
const SECRET = "s".repeat(40);
const REQUIRED = { x402Version: 2, accepts: [{ scheme: "work", network: "quai:9", amount: "4096" }] };

type Call = { url: string; init?: RequestInit; request?: Request };
let calls: Call[];
let facilitator: (path: string, body: any) => Response | Promise<Response>;
let origin: (request: Request) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
	calls = [];
	origin = (request) => new Response(`origin saw ${new URL(request.url).pathname}`, { headers: { "x-origin": "yes" } });
	facilitator = (path) =>
		path.endsWith("/requirements")
			? Response.json({ paymentRequired: REQUIRED, paymentRequiredHeader: "UkVR" })
			: Response.json({ success: true, transaction: "0xabc", network: "quai:9", paymentResponseHeader: "UkVT" });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (input instanceof Request) {
			calls.push({ url: input.url, request: input });
			return origin(input);
		}
		const url = String(input);
		calls.push({ url, init });
		return facilitator(new URL(url).pathname, JSON.parse(String(init?.body ?? "{}")));
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const env = (extra: Partial<Env> = {}): Env => ({ PAY_TO, PROTECTED_PATTERNS: "/premium/*,/report", ORIGIN_URL: "https://origin.example", JWT_SECRET: SECRET, ...extra });
const call = (path: string, init: RequestInit = {}, e = env()) => worker.fetch(new Request("https://proxy.example" + path, init), e);
const facilitatorCalls = () => calls.filter((c) => c.url.startsWith("https://x402.qu.ai"));

describe("routes", () => {
	test("patterns: prefixes, exact paths and everything", () => {
		expect(isProtected("/premium", ["/premium/*"])).toBe(true);
		expect(isProtected("/premium/a/b", ["/premium/*"])).toBe(true);
		expect(isProtected("/premiumx", ["/premium/*"])).toBe(false);
		expect(isProtected("/report", ["/report"])).toBe(true);
		expect(isProtected("/report/x", ["/report"])).toBe(false);
		expect(isProtected("/anything", ["*"])).toBe(true);
		expect(isProtected("/free", [])).toBe(false);
	});

	test("health reports the setup, and refuses the placeholder address", async () => {
		const ok = await call("/__x402/health");
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ ok: true, price: { guesses: "4096", profile: "quai/sha256d-v1" }, protected: ["/__x402/protected", "/premium/*", "/report"], origin: true, accessSeconds: 3600 });
		const placeholder = await call("/__x402/health", {}, env({ PAY_TO: "0x" + "0".repeat(40) }));
		expect(placeholder.status).toBe(500);
		expect(((await placeholder.json()) as any).problem).toMatch(/placeholder zero address/);
	});

	test("blank variables fall back to their defaults instead of becoming 0 or empty", () => {
		const s = settings(env({ ACCESS_SECONDS: "", PRICE: " ", PROFILE: "", ORIGIN_URL: " " }));
		expect(s.accessSeconds).toBe(3600);
		expect(s.price).toBe("4096");
		expect(s.profile).toBe("quai/sha256d-v1");
		expect(s.origin).toBeUndefined();
		expect(settings(env({ ACCESS_SECONDS: "0" })).accessSeconds).toBe(0);
		expect(settings(env({ ACCESS_SECONDS: "-5" })).accessSeconds).toBe(3600);
	});

	test("unprotected requests go straight to the origin without our headers", async () => {
		const response = await call("/free?q=1", { headers: { cookie: `a=1; ${COOKIE}=tok; b=2`, "payment-signature": "x" } });
		expect(await response.text()).toBe("origin saw /free");
		const forwarded = calls[0]!.request!;
		expect(forwarded.url).toBe("https://origin.example/free?q=1");
		expect(forwarded.headers.get("cookie")).toBe("a=1; b=2");
		expect(forwarded.headers.get("payment-signature")).toBeNull();
		expect(facilitatorCalls()).toHaveLength(0);
	});

	test("no origin: 404 for unprotected routes, the demo route still works", async () => {
		expect((await call("/free", {}, env({ ORIGIN_URL: "" }))).status).toBe(404);
		expect((await call("/__x402/protected", {}, env({ ORIGIN_URL: "" }))).status).toBe(402);
	});

	test("an origin that is this Worker is refused", async () => {
		expect((await call("/free", {}, env({ ORIGIN_URL: "https://proxy.example" }))).status).toBe(508);
	});

	test("health stays public when every route is protected", async () => {
		expect((await call("/__x402/health", {}, env({ PROTECTED_PATTERNS: "*" }))).status).toBe(200);
		expect(calls).toHaveLength(0);
	});

	test("no patterns leaves application routes public but keeps the demo protected", async () => {
		const e = env({ PROTECTED_PATTERNS: "" });
		expect((await call("/report", {}, e)).status).toBe(200);
		expect(facilitatorCalls()).toHaveLength(0);
		expect((await call("/__x402/protected", {}, e)).status).toBe(402);
	});
});

describe("payment", () => {
	test("an unpaid protected request gets the facilitator's 402, bound to the route", async () => {
		const response = await call("/premium/data?x=1");
		expect(response.status).toBe(402);
		expect(response.headers.get("payment-required")).toBe("UkVR");
		expect(await response.json()).toEqual(REQUIRED);
		const [requirements] = facilitatorCalls();
		expect(JSON.parse(String(requirements!.init!.body))).toMatchObject({ payTo: PAY_TO, amount: "4096", profile: "quai/sha256d-v1", resource: { url: "https://proxy.example/premium/data" } });
		expect(calls.some((c) => c.url.startsWith("https://origin.example"))).toBe(false);
	});

	test("browsers get a page; the terms stay in the header", async () => {
		const response = await call("/report", { headers: { accept: "text/html" } });
		expect(response.status).toBe(402);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("payment-required")).toBe("UkVR");
		expect(await response.text()).toContain("x402-work pay https://proxy.example/report");
	});

	test("a paid request reaches the origin, with the receipt and an access cookie that skips payment next time", async () => {
		const paid = await call("/premium/data", { headers: { "payment-signature": "proof" } });
		expect(paid.status).toBe(200);
		expect(await paid.text()).toBe("origin saw /premium/data");
		expect(paid.headers.get("payment-response")).toBe("UkVT");
		expect(paid.headers.get("x-origin")).toBe("yes");
		const settle = facilitatorCalls().find((c) => c.url.endsWith("/settle"))!;
		expect(JSON.parse(String(settle.init!.body))).toMatchObject({ paymentSignature: "proof", payTo: PAY_TO, amount: "4096" });
		const cookie = paid.headers.get("set-cookie")!;
		expect(cookie).toMatch(new RegExp(`^${COOKIE}=[^;]+; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax$`));

		calls = [];
		const again = await call("/report", { headers: { cookie: cookie.split(";")[0]! } });
		expect(await again.text()).toBe("origin saw /report");
		expect(facilitatorCalls()).toHaveLength(0);
	});

	test("without JWT_SECRET, or with ACCESS_SECONDS 0, every request pays", async () => {
		for (const e of [env({ JWT_SECRET: undefined }), env({ ACCESS_SECONDS: "0" })]) {
			const paid = await call("/report", { headers: { "payment-signature": "proof" } }, e);
			expect(paid.status).toBe(200);
			expect(paid.headers.get("set-cookie")).toBeNull();
		}
	});

	test("a rejected proof gets a fresh 402 that says why", async () => {
		facilitator = (path) =>
			path.endsWith("/settle")
				? Response.json({ error: { message: "The work was already spent" } }, { status: 400 })
				: Response.json({ paymentRequired: REQUIRED, paymentRequiredHeader: "UkVR" });
		const response = await call("/report", { headers: { "payment-signature": "replayed" } });
		expect(response.status).toBe(402);
		expect(((await response.json()) as any).error).toBe("The work was already spent");
	});

	test("a facilitator that refuses the proxy's settings is a 502 without Retry-After", async () => {
		facilitator = () => Response.json({ error: { message: "Unsupported profile" } }, { status: 400 });
		const response = await call("/report");
		expect(response.status).toBe(502);
		expect(response.headers.get("retry-after")).toBeNull();
		expect(((await response.json()) as any).error.message).toMatch(/refused this proxy's settings: Unsupported profile/);
	});

	test("a rate-limited proxy passes on 429 with Retry-After", async () => {
		facilitator = () => Response.json({ error: { message: "Slow down" } }, { status: 429, headers: { "retry-after": "7" } });
		const response = await call("/report");
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("7");
	});

	test("an unavailable facilitator is a 503 with Retry-After, and nothing reaches the origin", async () => {
		facilitator = () => Response.json({ error: { message: "No live work source" } }, { status: 503, headers: { "retry-after": "12" } });
		const response = await call("/report");
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("12");
		expect(calls.some((c) => c.url.startsWith("https://origin.example"))).toBe(false);
	});

	test("disabling access cookies also rejects a cookie issued before the change", async () => {
		const token = await issueAccess(SECRET, "proxy.example", 3600);
		const response = await call("/report", { headers: { cookie: `${COOKIE}=${token}` } }, env({ ACCESS_SECONDS: "0" }));
		expect(response.status).toBe(402);
		expect(facilitatorCalls()).toHaveLength(1);
		expect(calls.some((c) => c.request)).toBe(false);
	});

	test("valid access works during a facilitator outage", async () => {
		facilitator = () => { throw new Error("Offline"); };
		const token = await issueAccess(SECRET, "proxy.example", 3600);
		expect((await call("/report", { headers: { cookie: `${COOKIE}=${token}` } })).status).toBe(200);
		expect(facilitatorCalls()).toHaveLength(0);
	});

	test.each(["expired", "wrong host", "wrong secret", "malformed"])("a cookie that is %s requires fresh work", async (kind) => {
		const token = kind === "malformed" ? "garbage" : await issueAccess(
			kind === "wrong secret" ? "t".repeat(40) : SECRET,
			kind === "wrong host" ? "other.example" : "proxy.example",
			kind === "expired" ? -60 : 3600,
		);
		expect((await call("/report", { headers: { cookie: `${COOKIE}=${token}` } })).status).toBe(402);
		expect(calls.some((c) => c.request)).toBe(false);
	});

	test.each([["unset", undefined], ["too short", "short"]] as const)("a disabled signing secret (%s) rejects existing cookies", async (_name, secret) => {
		const token = await issueAccess(SECRET, "proxy.example", 3600);
		expect((await call("/report", { headers: { cookie: `${COOKIE}=${token}` } }, env({ JWT_SECRET: secret }))).status).toBe(402);
		expect(calls.some((c) => c.request)).toBe(false);
	});

	test.each([429, 503])("HTTP %i with no supplied retry delay uses 30 seconds", async (status) => {
		facilitator = () => Response.json({ error: { message: "Try later" } }, { status });
		const response = await call("/report");
		expect(response.status).toBe(status);
		expect(response.headers.get("retry-after")).toBe("30");
		expect(calls.some((c) => c.request)).toBe(false);
	});

	test("a malformed settlement cannot reach the origin or issue an access cookie", async () => {
		facilitator = () => Response.json({ success: "true", paymentResponseHeader: "UkVT" });
		const response = await call("/report", { headers: { "payment-signature": "proof" } });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_response" } });
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(calls.some((c) => c.request)).toBe(false);
	});

	test("malformed requirements produce an upstream error rather than an unusable challenge", async () => {
		facilitator = () => Response.json({});
		const response = await call("/report");
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_response" } });
		expect(response.headers.get("payment-required")).toBeNull();
		expect(calls.some((c) => c.request)).toBe(false);
	});

	test("a lost settlement response does not forward or promise that no work was spent", async () => {
		facilitator = () => { throw new Error("Connection lost"); };
		const response = await call("/report", { headers: { "payment-signature": "proof" } });
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("5");
		expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("settlement outcome is unknown") } });
		expect(calls.some((c) => c.request)).toBe(false);
	});

	test("a paid POST settles before forwarding the original body and keeps unrelated cookies", async () => {
		const response = await call("/report?format=csv", {
			method: "POST", body: "report body",
			headers: { "payment-signature": "proof", cookie: `session=abc; ${COOKIE}=invalid`, "content-type": "text/plain" },
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[0]!.url).toBe("https://x402.qu.ai/v1/facilitator/settle");
		expect(JSON.parse(String(calls[0]!.init!.body)).resource.url).toBe("https://proxy.example/report");
		const forwarded = calls[1]!.request!;
		expect(forwarded.url).toBe("https://origin.example/report?format=csv");
		expect(forwarded.method).toBe("POST");
		expect(await forwarded.text()).toBe("report body");
		expect(forwarded.headers.get("payment-signature")).toBeNull();
		expect(forwarded.headers.get("cookie")).toBe("session=abc");
	});

	test("origin redirects are returned without being followed", async () => {
		origin = () => new Response(null, { status: 302, headers: { location: "https://other.example" } });
		const response = await call("/report", { headers: { "payment-signature": "proof" } });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://other.example");
		expect(calls.at(-1)!.request!.redirect).toBe("manual");
		expect(calls).toHaveLength(2);
	});

	test("the paid demo works without an origin and never forwards", async () => {
		const response = await call("/__x402/protected", { headers: { "payment-signature": "proof" } }, env({ ORIGIN_URL: undefined }));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ message: expect.stringContaining("Paid with proof of work") });
		expect(calls.some((c) => c.request)).toBe(false);
	});

	// Characterize the existing settlement-before-delivery policy; these do not assert refunds or recovery.
	test("an origin HTTP error after payment retains the receipt and access cookie", async () => {
		origin = () => new Response("Origin unavailable", { status: 503, headers: { "set-cookie": "session=abc; Path=/" } });
		const response = await call("/report", { headers: { "payment-signature": "proof" } });
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("Origin unavailable");
		expect(response.headers.get("payment-response")).toBe("UkVT");
		expect(response.headers.get("set-cookie")).toContain("session=abc");
		expect(response.headers.get("set-cookie")).toContain(`${COOKIE}=`);
		expect(calls).toHaveLength(2);
	});

	test("an origin transport failure after settlement propagates without attempting another payment", async () => {
		origin = () => { throw new Error("Origin connection lost"); };
		await expect(call("/report", { headers: { "payment-signature": "proof" } })).rejects.toThrow("Origin connection lost");
		expect(calls).toHaveLength(2);
		expect(calls[0]!.url).toBe("https://x402.qu.ai/v1/facilitator/settle");
	});
});

describe("access cookie", () => {
	test("is bound to the host, expires, and can't be forged", async () => {
		const now = Date.now();
		const token = await issueAccess(SECRET, "proxy.example", 60, now);
		expect(await hasAccess(SECRET, "proxy.example", token, now)).toBe(true);
		expect(await hasAccess(SECRET, "other.example", token, now)).toBe(false);
		expect(await hasAccess(SECRET, "proxy.example", token, now + 61_000)).toBe(false);
		expect(await hasAccess("t".repeat(40), "proxy.example", token, now)).toBe(false);
		const [h, , s] = token.split(".");
		const forged = btoa(JSON.stringify({ aud: "proxy.example", exp: 9e9 })).replace(/=+$/, "");
		expect(await hasAccess(SECRET, "proxy.example", `${h}.${forged}.${s}`, now)).toBe(false);
		expect(await hasAccess(SECRET, "proxy.example", "garbage", now)).toBe(false);
	});

	test("validates tokens whose unpadded parts have every length remainder", async () => {
		// Hosts of 1 to 4 extra characters move the payload's base64url length through 0, 2 and 3 (mod 4).
		for (const host of ["a.example", "ab.example", "abc.example", "abcd.example"]) {
			const token = await issueAccess(SECRET, host, 60);
			expect(token).not.toContain("=");
			expect(await hasAccess(SECRET, host, token)).toBe(true);
		}
	});

	test("access expires exactly at the expiry boundary", async () => {
		const now = 1_800_000_000_000;
		const token = await issueAccess(SECRET, "proxy.example", 60, now);
		expect(await hasAccess(SECRET, "proxy.example", token, now + 59_999)).toBe(true);
		expect(await hasAccess(SECRET, "proxy.example", token, now + 60_000)).toBe(false);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker, { isProtected, type Env } from "../src/index";
import { COOKIE, hasAccess, issueAccess } from "../src/access";

const PAY_TO = "0x007f5aC8d9D06a27565172cB75F8e5589074f8E4";
const SECRET = "s".repeat(40);
const REQUIRED = { x402Version: 2, accepts: [{ scheme: "work", network: "quai:9", amount: "4096" }] };

type Call = { url: string; init?: RequestInit; request?: Request };
let calls: Call[];
let facilitator: (path: string, body: any) => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
	calls = [];
	facilitator = (path) =>
		path.endsWith("/requirements")
			? Response.json({ paymentRequired: REQUIRED, paymentRequiredHeader: "UkVR" })
			: Response.json({ success: true, transaction: "0xabc", network: "quai:9", paymentResponseHeader: "UkVT" });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (input instanceof Request) {
			calls.push({ url: input.url, request: input });
			return new Response(`origin saw ${new URL(input.url).pathname}`, { headers: { "x-origin": "yes" } });
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

	test("an unavailable facilitator is a 503 with Retry-After, and nothing reaches the origin", async () => {
		facilitator = () => Response.json({ error: { message: "No live work source" } }, { status: 503, headers: { "retry-after": "12" } });
		const response = await call("/report");
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("12");
		expect(calls.some((c) => c.url.startsWith("https://origin.example"))).toBe(false);
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
});

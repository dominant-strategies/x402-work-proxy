import { describe, expect, test } from "bun:test";
import { workSeller } from "../src/seller";

const PAY_TO = "0x007f5aC8d9D06a27565172cB75F8e5589074f8E4";
const RESOURCE = { url: "https://proxy.example/report", description: "Report" };
const REQUIRED = { x402Version: 2, accepts: [{ scheme: "work", amount: "4096" }] };

function sellerWith(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	return workSeller({
		payTo: PAY_TO,
		amount: "4096",
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => reply(String(input), init)) as typeof fetch,
	});
}

describe("facilitator retry delays", () => {
	test.each([429, 503])("HTTP %i uses the JSON delay when Retry-After is absent", async (status) => {
		const seller = sellerWith(() => Response.json({ error: { message: "Try later", retryAfterSeconds: 17 } }, { status }));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ status, retryAfter: 17 });
	});

	test("an absent delay stays undefined so the Worker can use its default", async () => {
		const seller = sellerWith(() => Response.json({ error: { message: "Try later" } }, { status: 503 }));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ retryAfter: undefined });
	});

	test.each(["", " ", "-1", "1.5", "later"])("invalid header %j falls back to the JSON delay", async (header) => {
		const seller = sellerWith(() => Response.json({ error: { retryAfterSeconds: 17 } }, { status: 503, headers: { "retry-after": header } }));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ retryAfter: 17 });
	});

	test.each([0, 7])("an explicit header delay of %i takes precedence", async (delay) => {
		const seller = sellerWith(() => Response.json({ error: { retryAfterSeconds: 17 } }, { status: 429, headers: { "retry-after": String(delay) } }));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ retryAfter: delay });
	});

	test.each([-1, 1.5, "17", null])("invalid JSON delay %j is ignored", async (delay) => {
		const seller = sellerWith(() => Response.json({ error: { retryAfterSeconds: delay } }, { status: 503 }));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ retryAfter: undefined });
	});
});

describe("facilitator response contract", () => {
	test.each([
		["null", null],
		["array", []],
		["missing fields", {}],
		["missing challenge", { paymentRequiredHeader: "UkVR" }],
		["null challenge", { paymentRequired: null, paymentRequiredHeader: "UkVR" }],
		["missing header", { paymentRequired: REQUIRED }],
		["blank header", { paymentRequired: REQUIRED, paymentRequiredHeader: " " }],
	])("rejects requirements with %s", async (_name, payload) => {
		const seller = sellerWith(() => Response.json(payload));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ name: "WorkSellerError", status: 502, code: "invalid_response" });
	});

	test("rejects a non-JSON success response", async () => {
		const seller = sellerWith(() => new Response("<html>upstream error</html>"));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ status: 502, code: "invalid_response" });
	});

	test.each([
		["null", null],
		["missing success", {}],
		["string success", { success: "true", paymentResponseHeader: "UkVT" }],
		["missing receipt header", { success: true }],
		["blank receipt header", { success: true, paymentResponseHeader: "" }],
	])("rejects settlement with %s instead of granting access", async (_name, payload) => {
		const paths: string[] = [];
		const seller = sellerWith((url) => {
			paths.push(new URL(url).pathname);
			return Response.json(payload);
		});
		await expect(seller.charge({ ...RESOURCE, paymentSignature: "proof" })).rejects.toMatchObject({ status: 502, code: "invalid_response" });
		expect(paths).toEqual(["/v1/facilitator/settle"]);
	});

	test("a rejected settlement obtains a fresh challenge with the same resource and terms", async () => {
		const requests: { path: string; body: any }[] = [];
		const seller = sellerWith((url, init) => {
			const path = new URL(url).pathname;
			requests.push({ path, body: JSON.parse(String(init?.body)) });
			return path.endsWith("/settle")
				? Response.json({ success: false, errorReason: "Already spent" })
				: Response.json({ paymentRequired: REQUIRED, paymentRequiredHeader: "UkVR" });
		});
		const charge = await seller.charge({ ...RESOURCE, paymentSignature: "proof" });
		expect(charge).toMatchObject({ paid: false, status: 402, body: { ...REQUIRED, error: "Already spent" } });
		expect(requests.map((request) => request.path)).toEqual(["/v1/facilitator/settle", "/v1/facilitator/requirements"]);
		for (const { body } of requests) expect(body).toMatchObject({ payTo: PAY_TO, amount: "4096", resource: RESOURCE });
	});

	test("non-JSON server errors retain their retryable status", async () => {
		const seller = sellerWith(() => new Response("Unavailable", { status: 502 }));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ status: 503, code: "facilitator_unavailable" });
	});

	test("null error responses retain their retryable status", async () => {
		const seller = sellerWith(() => Response.json(null, { status: 503 }));
		await expect(seller.charge(RESOURCE)).rejects.toMatchObject({ name: "WorkSellerError", status: 503, code: "facilitator_unavailable" });
	});

	test("a lost settlement response reports an unknown payment outcome", async () => {
		const seller = sellerWith(() => { throw new Error("Connection lost"); });
		await expect(seller.charge({ ...RESOURCE, paymentSignature: "proof" })).rejects.toMatchObject({
			status: 503,
			code: "facilitator_unreachable",
			message: expect.stringContaining("settlement outcome is unknown"),
		});
	});
});

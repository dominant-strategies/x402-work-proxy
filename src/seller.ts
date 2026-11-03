// Charge with x402 Work through the hosted facilitator, from a Worker.
// Ported from x402-work-client 0.4.0 (seller.mjs), which needs nothing but
// fetch: the facilitator issues each job for your address, then verifies and
// spends each answer once. Answers good enough for the network are submitted,
// and the block reward goes to your address. You run no node, verifier or
// database. https://x402.qu.ai/docs/sell

export const DEFAULT_FACILITATOR = "https://x402.qu.ai";

export type ErrorCode = "facilitator_unavailable" | "facilitator_unreachable" | "rate_limited" | "invalid_request" | "invalid_response";

/**
 * The facilitator couldn't issue or settle work: unreachable, no live work
 * source (503), rate limiting you (429), refusing the configuration (400), or
 * returning malformed data (502). A lost settlement response leaves the payment
 * outcome unknown. Return Retry-After only with retryable response statuses.
 */
export class WorkSellerError extends Error {
	readonly status: number;
	readonly code: ErrorCode;
	readonly retryAfter?: number;
	constructor(message: string, { status = 503, retryAfter, code = "facilitator_unavailable" }: { status?: number; retryAfter?: number; code?: ErrorCode } = {}) {
		super(message);
		this.name = "WorkSellerError";
		this.status = status;
		this.code = code;
		if (retryAfter !== undefined) this.retryAfter = retryAfter;
	}
}

export interface SellerOptions {
	/** Your Cyprus-1 QUAI address, or a Monero address with profile monero/randomx-v1. */
	payTo: string;
	/** The price in expected guesses. */
	amount: string | number;
	profile?: string;
	facilitator?: string;
	fetch?: typeof fetch;
}

export type Charge =
	| { paid: false; status: 402; headers: Record<string, string>; body: unknown }
	| { paid: true; receipt: Record<string, unknown>; headers: Record<string, string> };

const MONERO_ADDRESS = /^[48][1-9A-HJ-NP-Za-km-z]{94}$/;
const QUAI_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const seconds = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const isPaymentHeader = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\0\r\n]/.test(value);

export function workSeller({ payTo, amount, profile = "quai/sha256d-v1", facilitator = DEFAULT_FACILITATOR, fetch: fetchImpl = fetch }: SellerOptions) {
	if (profile === "monero/randomx-v1" ? !MONERO_ADDRESS.test(payTo) : !QUAI_ADDRESS.test(payTo))
		throw new Error(profile === "monero/randomx-v1" ? "PAY_TO must be a Monero address for monero/randomx-v1" : "PAY_TO must be a QUAI address (0x followed by 40 hex digits)");
	if (/^0x0{40}$/.test(payTo)) throw new Error("PAY_TO is still the placeholder zero address; set it to your QUAI address");
	const price = String(amount);
	if (!/^[1-9][0-9]*$/.test(price)) throw new Error("PRICE must be a whole number of expected guesses");
	const base = facilitator.replace(/\/$/, "");
	const invalidResponse = () => new WorkSellerError(`The x402 Work facilitator at ${base} returned an invalid response.`, { status: 502, code: "invalid_response" });

	async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await fetchImpl(base + path, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(20_000),
			});
		} catch {
			const outcome = path.endsWith("/settle") ? " The settlement outcome is unknown." : "";
			throw new WorkSellerError(`The x402 Work facilitator at ${base} could not be reached.${outcome}`, {
				status: 503,
				retryAfter: 5,
				code: "facilitator_unreachable",
			});
		}
		const data: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const error = isRecord(data) && isRecord(data.error) ? data.error : undefined;
			const header = response.headers.get("retry-after")?.trim();
			const headerDelay = header && /^[0-9]+$/.test(header) ? seconds(Number(header)) : undefined;
			const retryAfter = headerDelay ?? seconds(error?.retryAfterSeconds);
			const code: ErrorCode = response.status === 429 ? "rate_limited" : response.status >= 500 ? "facilitator_unavailable" : "invalid_request";
			throw new WorkSellerError(typeof error?.message === "string" && error.message ? error.message : `Facilitator returned ${response.status}`, {
				status: response.status >= 500 ? 503 : response.status,
				retryAfter,
				code,
			});
		}
		if (!isRecord(data)) throw invalidResponse();
		return data;
	}

	async function offer(resource: Record<string, string>, error?: string): Promise<Charge> {
		const r = await post("/v1/facilitator/requirements", { payTo, amount: price, profile, resource });
		if (!isRecord(r.paymentRequired) || !isPaymentHeader(r.paymentRequiredHeader)) throw invalidResponse();
		return {
			paid: false,
			status: 402,
			headers: { "payment-required": r.paymentRequiredHeader },
			body: error ? { ...r.paymentRequired, error } : r.paymentRequired,
		};
	}

	return {
		/**
		 * Call once per request. Without a payment, returns the 402 to send. With one,
		 * settles it and returns { paid: true, receipt, headers }. A rejected proof
		 * returns a fresh 402. Throws WorkSellerError when the facilitator is unavailable.
		 */
		async charge({ url, description, mimeType, paymentSignature }: { url: string; description?: string; mimeType?: string; paymentSignature?: string | null }): Promise<Charge> {
			const resource = { url, ...(description ? { description } : {}), ...(mimeType ? { mimeType } : {}) };
			if (!paymentSignature) return offer(resource);
			// A proof the facilitator rejects (400, 404) gets a fresh 402; outages and rate limits are thrown.
			const settled: Record<string, unknown> = await post("/v1/facilitator/settle", { paymentSignature, payTo, amount: price, resource }).catch((error) => {
				if (error instanceof WorkSellerError && error.code === "invalid_request") return { success: false, errorReason: error.message };
				throw error;
			});
			if (typeof settled.success !== "boolean") throw invalidResponse();
			if (!settled.success) return offer(resource, typeof settled.errorReason === "string" && settled.errorReason ? settled.errorReason : "The work was not accepted");
			const { paymentResponseHeader, ...receipt } = settled;
			if (!isPaymentHeader(paymentResponseHeader)) throw invalidResponse();
			return { paid: true, receipt, headers: { "payment-response": paymentResponseHeader } };
		},
	};
}

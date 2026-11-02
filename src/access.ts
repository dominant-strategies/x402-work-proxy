// Paid access as a signed cookie: after one payment the visitor reaches the
// protected routes for ACCESS_SECONDS with no further work and no server-side
// state. A compact HS256 JWT made with Web Crypto.

const encoder = new TextEncoder();
export const COOKIE = "x402_work_access";

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret: string, data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** Constant-time comparison of two signatures. */
function same(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export async function issueAccess(secret: string, host: string, seconds: number, now = Date.now()): Promise<string> {
	const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
	const payload = base64url(encoder.encode(JSON.stringify({ aud: host, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + seconds })));
	return `${header}.${payload}.${base64url(await hmac(secret, `${header}.${payload}`))}`;
}

/** True when the token is ours, for this host, and unexpired. */
export async function hasAccess(secret: string, host: string, token: string | undefined, now = Date.now()): Promise<boolean> {
	const parts = token?.split(".");
	if (!parts || parts.length !== 3) return false;
	const [header, payload, signature] = parts as [string, string, string];
	try {
		if (!same(fromBase64url(signature), await hmac(secret, `${header}.${payload}`))) return false;
		const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
		return claims.aud === host && typeof claims.exp === "number" && claims.exp * 1000 > now;
	} catch {
		return false;
	}
}

export function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
}

export const accessCookie = (token: string, seconds: number) => `${COOKIE}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;

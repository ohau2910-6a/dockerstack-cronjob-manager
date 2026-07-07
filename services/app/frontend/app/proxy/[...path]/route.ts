import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side proxy: the browser calls /proxy/, this route forwards to the
 * backend and injects x-api-secret. The API secret NEVER reaches the client
 * (spec §6: frontend does not talk to cronjob.org/providers directly, and the
 * secret stays server-side).
 *
 * NAMESPACE: the shared secret uses the CRONJOB_MANAGER_ prefix so it does not
 * collide with docker-stack-template env. BACKEND_URL is an internal runtime
 * var set by entrypoint.sh and stays unprefixed.
 */
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8080";
const API_SECRET = process.env.CRONJOB_MANAGER_API_SECRET ?? "change-me-super-secret";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest, ctx: { params: { path: string[] } }) {
 const path = ctx.params.path.join("/");
 const search = req.nextUrl.search;
 const url = `${BACKEND}/api/${path}${search}`;

 const headers: Record<string, string> = {
 "x-api-secret": API_SECRET,
 };
 const contentType = req.headers.get("content-type");
 if (contentType) headers["content-type"] = contentType;

 const method = req.method;
 const body =
 method === "GET" || method === "HEAD" ? undefined : await req.text();

 try {
 const res = await fetch(url, { method, headers, body });
 const text = await res.text();
 return new NextResponse(text, {
 status: res.status,
 headers: {
 "content-type": res.headers.get("content-type") ?? "application/json",
 },
 });
 } catch (err) {
 return NextResponse.json(
 { error: `proxy failed: ${(err as Error).message}`, backend: BACKEND },
 { status: 502 },
 );
 }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
export const PUT = handle;

import { z } from "zod";
import { parseEnvJson, parseEnvString } from "./parseEnv.js";

/**
 * Central typed config. Every JSON-shaped ENV goes through parseEnv
 * (base64 → raw fallback) and is validated with zod, fail-fast at boot.
 *
 * NAMESPACE: every app-specific env var uses the CRONJOB_MANAGER_ prefix so it
 * never collides with docker-stack-template's own env (PROJECT_NAME, DOMAIN,
 * APP_PORT, TINYAUTH_* of the stack, etc.). PORT and NODE_ENV are left as
 * runtime/standard vars (PORT is set per-process by entrypoint.sh).
 */

const boolean = (v: string | undefined, def: boolean): boolean => {
 if (v === undefined) return def;
 return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

const numberOr = (v: string | undefined, def: number): number => {
 if (v === undefined || v === "") return def;
 const n = Number(v);
 return Number.isFinite(n) ? n : def;
};

export interface ServiceAccount {
 project_id: string;
 client_email: string;
 private_key: string;
 [k: string]: unknown;
}

export interface AppConfig {
 port: number;
 logLevel: string;
 logFormat: "json" | "pretty";

 apiSecret: string;
 tinyAuthEnabled: boolean;
 tinyAuthUsers: Record<string, string>;

 firebase: {
 dbUrl: string;
 authSecret?: string;
 serviceAccount?: ServiceAccount;
 /** which auth mode was resolved */
 mode: "service_account" | "auth_secret" | "none";
 };
 rtdbExecQueuePath: string;

 cronjobApiBase: string;

 exec: {
 handlersDir: string;
 allowed: string[];
 timeoutMs: number;
 concurrency: number;
 logPayload: boolean;
 };

 secretEncryptionKey?: string;
}

const tinyAuthUsersSchema = z.record(z.string(), z.string());
const execAllowedSchema = z.array(z.string());
const serviceAccountSchema = z.object({
 project_id: z.string(),
 client_email: z.string(),
 private_key: z.string(),
}).passthrough();

/**
 * Resolve FIREBASE auth. Priority: service account JSON > auth secret.
 * Missing both → fail-fast with a clear message.
 */
function resolveFirebase(env: NodeJS.ProcessEnv, opts: { allowNone: boolean }) {
 // Explicit escape hatch for local/dev/demo without any Firebase credentials.
 if ((env.CRONJOB_MANAGER_RTDB_MODE ?? "").toLowerCase() === "memory") {
 return { dbUrl: env.CRONJOB_MANAGER_FIREBASE_DB_URL ?? "http://localhost:9000", mode: "none" as const };
 }

 const dbUrl = env.CRONJOB_MANAGER_FIREBASE_DB_URL;
 if (!dbUrl) {
 if (opts.allowNone) {
 return { dbUrl: "http://localhost:9000", mode: "none" as const };
 }
 throw new Error("CRONJOB_MANAGER_FIREBASE_DB_URL is required");
 }

 const saRaw = env.CRONJOB_MANAGER_FIREBASE_SERVICE_ACCOUNT;
 if (saRaw && saRaw.trim() !== "") {
 const parsed = serviceAccountSchema.parse(
 parseEnvJson("CRONJOB_MANAGER_FIREBASE_SERVICE_ACCOUNT", saRaw),
 );
 return { dbUrl, serviceAccount: parsed as ServiceAccount, mode: "service_account" as const };
 }

 const authSecret = env.CRONJOB_MANAGER_FIREBASE_AUTH_SECRET;
 if (authSecret && authSecret.trim() !== "") {
 return { dbUrl, authSecret, mode: "auth_secret" as const };
 }

 if (opts.allowNone) {
 return { dbUrl, mode: "none" as const };
 }
 throw new Error(
 "Firebase auth missing: provide CRONJOB_MANAGER_FIREBASE_SERVICE_ACCOUNT (preferred) or CRONJOB_MANAGER_FIREBASE_AUTH_SECRET",
 );
}

export function loadConfig(
 env: NodeJS.ProcessEnv = process.env,
 opts: { allowNone?: boolean } = {},
): AppConfig {
 const allowNone = opts.allowNone ?? env.NODE_ENV === "test";

 const apiSecret = env.CRONJOB_MANAGER_API_SECRET ?? (allowNone ? "test-secret" : "");
 if (!apiSecret) {
 throw new Error("CRONJOB_MANAGER_API_SECRET is required for all /api calls");
 }

 // NOTE: Trong docker-stack template, biến TINYAUTH_ENABLED / TINYAUTH_USERS
 // thuộc về service Tinyauth của STACK (Caddy forward_auth) và có định dạng
 // bcrypt escaped `$$` — KHÔNG phải JSON của app. Để tránh xung đột namespace,
 // gate nội bộ (redundant vì app đã nằm sau Tinyauth) dùng tiền tố
 // CRONJOB_MANAGER_.
 const tinyAuthEnabled = boolean(env.CRONJOB_MANAGER_TINYAUTH_ENABLED, false);
 let tinyAuthUsers: Record<string, string> = {};
 if (env.CRONJOB_MANAGER_TINYAUTH_USERS && env.CRONJOB_MANAGER_TINYAUTH_USERS.trim() !== "") {
 tinyAuthUsers = tinyAuthUsersSchema.parse(
 parseEnvJson("CRONJOB_MANAGER_TINYAUTH_USERS", env.CRONJOB_MANAGER_TINYAUTH_USERS),
 );
 }

 let execAllowed: string[] = [];
 if (env.CRONJOB_MANAGER_EXEC_ALLOWED && env.CRONJOB_MANAGER_EXEC_ALLOWED.trim() !== "") {
 execAllowed = execAllowedSchema.parse(parseEnvJson("CRONJOB_MANAGER_EXEC_ALLOWED", env.CRONJOB_MANAGER_EXEC_ALLOWED));
 }

 const fb = resolveFirebase(env, { allowNone });

 const logFormat = (env.CRONJOB_MANAGER_LOG_FORMAT === "json" ? "json" : env.CRONJOB_MANAGER_LOG_FORMAT === "pretty" ? "pretty" : "json") as
 | "json"
 | "pretty";

 return {
 port: numberOr(env.PORT, 8080),
 logLevel: env.CRONJOB_MANAGER_LOG_LEVEL ?? "info",
 logFormat,

 apiSecret,
 tinyAuthEnabled,
 tinyAuthUsers,

 firebase: fb,
 rtdbExecQueuePath: env.CRONJOB_MANAGER_RTDB_EXEC_QUEUE_PATH ?? "/exec-queue",

 cronjobApiBase: env.CRONJOB_MANAGER_CRONJOB_API_BASE ?? "https://api.cron-job.org",

 exec: {
 handlersDir: env.CRONJOB_MANAGER_EXEC_HANDLERS_DIR ?? "./handlers",
 allowed: execAllowed,
 timeoutMs: numberOr(env.CRONJOB_MANAGER_EXEC_TIMEOUT_MS, 30000),
 concurrency: numberOr(env.CRONJOB_MANAGER_EXEC_CONCURRENCY, 3),
 logPayload: boolean(env.CRONJOB_MANAGER_EXEC_LOG_PAYLOAD, false),
 },

 secretEncryptionKey: env.CRONJOB_MANAGER_SECRET_ENCRYPTION_KEY || undefined,
 };
}

export type { AppConfig as Config };

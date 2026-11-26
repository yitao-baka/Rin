import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { path_join } from "../utils/path";
import { getStorageBlobUrl, getStorageObject, putStorageObject } from "../utils/storage";

const DOWNLOAD_SESSION_TTL_SECONDS = 15 * 60;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ATTACHMENT_FOLDER = "attachments";

type TurnstileSettings = {
    enabled: boolean;
    siteKey?: string;
    secretKey?: string;
};

type TurnstileVerifyResult = {
    success?: boolean;
    hostname?: string;
    "error-codes"?: string[];
};

function buf2hex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

function getTurnstileSettings(env: Env): TurnstileSettings {
    const siteKey = env.TURNSTILE_SITE_KEY?.trim();
    const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
    return {
        enabled: Boolean(siteKey && secretKey),
        siteKey,
        secretKey,
    };
}

export function getAttachmentStoragePrefix(env: Env) {
    return path_join(env.S3_FOLDER || "", ATTACHMENT_FOLDER);
}

export function isAttachmentStorageKey(env: Env, storageKey: string) {
    const prefix = getAttachmentStoragePrefix(env);
    return storageKey === prefix || storageKey.startsWith(`${prefix}/`);
}

function hostnameFromUrl(value?: string | null) {
    if (!value) {
        return undefined;
    }
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return undefined;
    }
}

function getExpectedTurnstileHosts(c: AppContext, env: Env) {
    const configured = (env.TURNSTILE_EXPECTED_HOSTNAME || "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);

    if (configured.length > 0) {
        return configured;
    }

    const frontendHost = hostnameFromUrl(env.FRONTEND_URL);
    if (frontendHost) {
        return [frontendHost];
    }

    const originHost = hostnameFromUrl(c.req.header("origin"));
    return originHost ? [originHost] : [];
}

async function verifyTurnstileToken(env: Env, token: string, remoteIp?: string): Promise<TurnstileVerifyResult> {
    const body = new URLSearchParams();
    body.set("secret", env.TURNSTILE_SECRET_KEY!);
    body.set("response", token);
    if (remoteIp) {
        body.set("remoteip", remoteIp);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        throw new Error(`Turnstile siteverify failed (${response.status})`);
    }

    return await response.json() as TurnstileVerifyResult;
}

/**
 * Issues the short-lived session that unlocks attachment downloads. The token
 * is returned to the verified browser only; it is never written into a
 * downloadable URL.
 */
async function issueDownloadSession(c: AppContext, hostname: string) {
    const expiresAt = Date.now() + DOWNLOAD_SESSION_TTL_SECONDS * 1000;
    const session = await c.get("jwt").sign({
        scope: "download",
        host: hostname,
        exp: Math.floor(expiresAt / 1000),
    });

    return { session, expiresAt };
}

export function StorageService(): Hono {
    const app = new Hono();

    /**
     * Public configuration for the download gate. Only the public site key is
     * exposed; the secret never leaves the Worker.
     */
    app.get('/download-config', (c: AppContext) => {
        const settings = getTurnstileSettings(c.get('env'));
        return c.json(
            {
                enabled: settings.enabled,
                siteKey: settings.enabled ? settings.siteKey : undefined,
            },
            200,
            { 'cache-control': 'no-store' },
        );
    });

    /**
     * Exchanges a one-time Turnstile token for a short-lived signed download
     * session. The token is always checked against Cloudflare's siteverify
     * endpoint before a session is issued.
     */
    app.post('/download-verify', async (c: AppContext) => {
        const env = c.get('env');
        const settings = getTurnstileSettings(env);

        if (!settings.enabled) {
            return c.json({ error: 'Download verification is not configured' }, 503, { 'cache-control': 'no-store' });
        }

        const body = await c.req.json().catch(() => null) as { token?: unknown } | null;
        const token = typeof body?.token === "string" ? body.token.trim() : "";
        if (!token || token.length > 4096) {
            return c.json({ error: 'Invalid verification token' }, 400, { 'cache-control': 'no-store' });
        }

        let result: TurnstileVerifyResult;
        try {
            result = await verifyTurnstileToken(env, token, c.req.header("cf-connecting-ip"));
        } catch (error) {
            console.error("Turnstile verification failed:", error);
            return c.json({ error: 'Verification service unavailable' }, 502, { 'cache-control': 'no-store' });
        }

        if (result.success !== true) {
            return c.json(
                { error: 'Verification failed', codes: result["error-codes"] ?? [] },
                403,
                { 'cache-control': 'no-store' },
            );
        }

        const expectedHosts = getExpectedTurnstileHosts(c, env);
        const solvedHost = typeof result.hostname === "string" ? result.hostname.toLowerCase() : "";
        if (expectedHosts.length === 0) {
            return c.json({ error: 'Verification origin is required' }, 403, { 'cache-control': 'no-store' });
        }
        if (!solvedHost || !expectedHosts.includes(solvedHost)) {
            return c.json({ error: 'Verification hostname mismatch' }, 403, { 'cache-control': 'no-store' });
        }

        const session = await issueDownloadSession(c, solvedHost);
        return c.json(session, 200, { 'cache-control': 'no-store' });
    });

    // POST /storage
    app.post('/', async (c: AppContext) => {
        const uid = c.get('uid');
        const admin = c.get('admin');
        const env = c.get('env');

        // Only administrators may write to storage. This check runs before the
        // body is parsed so anonymous or regular users can never reach an
        // upload, regardless of what they send.
        if (!uid) {
            return c.text('Unauthorized', 401);
        }
        if (!admin) {
            return c.text('Forbidden', 403);
        }

        const body = await profileAsync(c, 'storage_parse', () => c.req.parseBody());
        const key = body.key as string;
        const file = body.file as File;
        const rawKind = body.kind;

        if (!file) {
            return c.text('No file uploaded', 400);
        }
        if (rawKind !== undefined && rawKind !== 'attachment' && rawKind !== 'image') {
            return c.text('Invalid file kind', 400);
        }
        const kind = rawKind === 'attachment' ? 'attachment' : 'image';

        const suffix = key.includes(".") ? key.split('.').pop() : "";
        const fileBuffer = await profileAsync(c, 'storage_file_buffer', () => file.arrayBuffer());
        const hashArray = await profileAsync(c, 'storage_hash', () => crypto.subtle.digest(
            { name: 'SHA-1' },
            fileBuffer
        ));
        const hash = buf2hex(hashArray);
        const hashkey = `${hash}.${suffix}`;
        const storagePath = kind === 'attachment' ? path_join(ATTACHMENT_FOLDER, hashkey) : hashkey;

        try {
            const origin = new URL(c.req.url).origin;
            const result = await profileAsync(c, 'storage_put', () => putStorageObject(env, storagePath, file, file.type, origin));
            const downloadUrl = getStorageBlobUrl(result.key, origin);

            return c.json({
                // Never advertise a public bucket URL for protected attachments.
                url: kind === 'attachment' ? downloadUrl : result.url,
                downloadUrl,
            });
        } catch (e: any) {
            console.error(e.message);
            const status = e.message?.includes('is not defined') ? 500 : 400;
            return c.text(e.message, status);
        }
    });

    return app;
}


/**
 * Files are served from the site origin, so an SVG or HTML object placed in
 * storage would otherwise execute as active content. Every publicly readable
 * object is forced to a passive disposition and given a non-scriptable
 * Content-Type; inline sniffing is disabled as well.
 */
const ACTIVE_CONTENT_TYPES = new Set([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'text/xml',
    'application/xml',
]);

function sanitizeDownloadFilename(value: string) {
    const cleaned = value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/]/g, '_')
        .replace(/["<>]/g, '_')
        .trim()
        .slice(0, 200);

    return cleaned || 'download';
}

function buildAttachmentDisposition(filename: string) {
    // Provide an ASCII fallback for old clients plus the RFC 5987 encoded name
    // so non-ASCII file names survive the round trip.
    const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const encoded = encodeURIComponent(filename).replace(
        /['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );

    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function buildPublicObjectHeaders(
    source: Headers,
    downloadName?: string | null,
    options: { gated?: boolean } = {},
) {
    const headers = new Headers();
    // Keep only approved metadata, including the encoding of the unchanged body.
    // Apply our security headers below instead of trusting stored values.
    const metadata = options.gated
        ? ['Content-Encoding', 'Content-Length', 'ETag', 'Last-Modified']
        : ['Content-Encoding', 'Content-Length', 'ETag', 'Last-Modified', 'Cache-Control'];
    for (const name of metadata) {
        const value = source.get(name);
        if (value) {
            headers.set(name, value);
        }
    }

    const contentType = (source.get('content-type') || 'application/octet-stream').toLowerCase();
    const active = [...ACTIVE_CONTENT_TYPES].some((type) => contentType.startsWith(type));

    headers.set('Content-Type', active ? 'application/octet-stream' : contentType);
    headers.set(
        'Content-Disposition',
        downloadName && downloadName.trim()
            ? buildAttachmentDisposition(sanitizeDownloadFilename(downloadName))
            : active || options.gated ? 'attachment' : 'inline',
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    // Blob bodies are user supplied; never let them run script on our origin.
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Access-Control-Allow-Origin', '*');

    if (options.gated) {
        // A shared cache must never replay a verified response to an anonymous
        // request, so gated attachments are explicitly non-cacheable.
        headers.set('Cache-Control', 'private, no-store');
        headers.set('Vary', 'x-download-session');
    }

    return headers;
}

export function BlobService(): Hono {
    const app = new Hono();

    app.get("/*", async (c: AppContext) => {
        const env = c.get("env");
        const rawKey = c.req.path.replace(/^\/blob\/?/, "");
        const downloadName = new URL(c.req.url).searchParams.get("download");

        if (!rawKey) {
            return c.text("Blob key is required", 400);
        }

        let key: string;
        try {
            key = decodeURIComponent(rawKey);
        } catch {
            return c.text("Invalid blob key", 400);
        }

        const gated = isAttachmentStorageKey(env, key);
        if (gated) {
            // Attachments fail closed when Turnstile is not fully configured,
            // otherwise the verification requirement could be bypassed.
            const settings = getTurnstileSettings(env);
            if (!settings.enabled) {
                return c.text("Download verification is not configured", 503, {
                    'cache-control': 'no-store',
                });
            }

            const session = c.req.header("x-download-session");
            const payload = session ? await c.get("jwt").verify(session) : false;
            if (!payload || payload.scope !== "download") {
                return c.text("Download verification required", 401, {
                    'cache-control': 'no-store',
                });
            }
        }

        try {
            const response = await profileAsync(c, "blob_fetch", () => getStorageObject(env, key));

            if (!response) {
                return c.text("Not found", 404);
            }

            return new Response(response.body, {
                status: response.status,
                headers: buildPublicObjectHeaders(response.headers, downloadName, { gated }),
            });
        } catch (error) {
            console.error("Blob fetch failed:", error);
            return c.text("Blob fetch failed", 500);
        }
    });

    return app;
}

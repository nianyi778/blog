/**
 * Pinterest Email Worker
 *
 * Two handlers:
 *   1. email() — Receives Pinterest emails, extracts images, stores in B2
 *   2. fetch() — Proxies B2 objects to the public (images + index.json)
 *                Cloudflare edge caches responses, so B2 is rarely hit.
 *
 * Architecture (MVP):
 *   Email → postal-mime parse → regex extract → fetch originals → B2 + index.json
 *   Browser/Vercel → Worker fetch handler → B2 (with edge cache)
 */
import PostalMime from 'postal-mime';
import type { B2Config } from './utils/b2-storage';
import { getJSON, getObject, putJSON, putObject } from './utils/b2-storage';
import {
	buildFallbackChain,
	extractAltText,
	extractPinUrl,
	extractPinterestImages,
} from './utils/extract-images';
import { fetchWithFallback, inferExtension, sha256 } from './utils/fetch-image';

// ── Types ──────────────────────────────────────────────────────────

export interface Env {
	// B2 S3-compatible config
	B2_ENDPOINT: string;
	B2_BUCKET_NAME: string;
	B2_KEY_ID: string; // Secret
	B2_APP_KEY: string; // Secret

	// Public URL of this Worker (for building image src in index.json)
	// e.g. https://pinterest-email-worker.yourdomain.workers.dev
	// or a custom domain like https://gallery.yourdomain.com
	WORKER_PUBLIC_URL: string;

	// Optional
	FORWARD_TO: string;
	VERCEL_DEPLOY_HOOK: string;
}

/** Shape of each entry in gallery/index.json — must match frontend GalleryImage */
interface GalleryImageEntry {
	id: string;
	src: string;
	thumb: string;
	alt: string;
	width: number;
	height: number;
	date: string;
	hash: string;
	sourceUrl: string;
	pinUrl?: string;
}

interface GalleryIndex {
	images: GalleryImageEntry[];
}

// ── Constants ──────────────────────────────────────────────────────

const INDEX_KEY = 'gallery/index.json';
const MAX_IMAGES_PER_EMAIL = 50;

// Images are immutable — cache for 1 year
const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// index.json updates when new images arrive — cache 5 min
const INDEX_CACHE_CONTROL = 'public, max-age=300';

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Helpers ────────────────────────────────────────────────────────

function b2Config(env: Env): B2Config {
	return {
		endpoint: env.B2_ENDPOINT,
		bucketName: env.B2_BUCKET_NAME,
		keyId: env.B2_KEY_ID,
		appKey: env.B2_APP_KEY,
	};
}

// ── Export Handler ─────────────────────────────────────────────────

export default {
	// ── Fetch Handler (image/JSON proxy) ───────────────────────────

	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		// CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		// Only serve /gallery/* paths
		if (!path.startsWith('/gallery/')) {
			return new Response('Not Found', { status: 404 });
		}

		// Strip leading slash → B2 object key
		const objectKey = path.slice(1); // "gallery/xxx.jpg" or "gallery/index.json"

		try {
			const config = b2Config(env);
			const b2Response = await getObject(config, objectKey);

			if (!b2Response) {
				return new Response('Not Found', {
					status: 404,
					headers: CORS_HEADERS,
				});
			}

			// Determine cache policy
			const isIndex = objectKey === INDEX_KEY;
			const cacheControl = isIndex ? INDEX_CACHE_CONTROL : IMAGE_CACHE_CONTROL;

			const contentType =
				b2Response.headers.get('content-type') ||
				(isIndex ? 'application/json' : 'image/jpeg');

			return new Response(b2Response.body, {
				status: 200,
				headers: {
					'Content-Type': contentType,
					'Cache-Control': cacheControl,
					...CORS_HEADERS,
				},
			});
		} catch (e) {
			console.error(`[proxy] Error fetching ${objectKey}: ${e}`);
			return new Response('Internal Server Error', {
				status: 500,
				headers: CORS_HEADERS,
			});
		}
	},

	// ── Email Handler ──────────────────────────────────────────────

	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		console.log(
			`[email] Received from: ${message.from}, subject: ${message.headers.get('subject') || '(none)'}`,
		);

		// 1. Parse MIME
		const rawEmail = new Response(message.raw);
		const arrayBuffer = await rawEmail.arrayBuffer();
		const parser = new PostalMime();
		const email = await parser.parse(arrayBuffer);

		const html = email.html || '';
		if (!html) {
			console.log('[email] No HTML body found, skipping.');
			return;
		}

		// 2. Extract Pinterest image URLs (content-based validation)
		//    Only i.pinimg.com URLs are extracted — non-Pinterest emails are naturally ignored.
		const imageUrls = extractPinterestImages(html);
		console.log(`[email] Found ${imageUrls.length} Pinterest image URLs.`);

		if (imageUrls.length === 0) {
			console.log('[email] No Pinterest images found, skipping.');
			if (env.FORWARD_TO) {
				await message.forward(env.FORWARD_TO);
			}
			return;
		}
		if (imageUrls.length === 0) return;
		if (imageUrls.length > MAX_IMAGES_PER_EMAIL) {
			console.warn(
				`[email] Too many images (${imageUrls.length}), capping at ${MAX_IMAGES_PER_EMAIL}.`,
			);
			imageUrls.length = MAX_IMAGES_PER_EMAIL;
		}

		// 4. Load existing index for dedup
		const config = b2Config(env);
		const index = (await getJSON<GalleryIndex>(config, INDEX_KEY)) || {
			images: [],
		};
		const existingHashes = new Set(index.images.map((img) => img.hash));
		const emailDate = message.headers.get('date') || new Date().toISOString();
		const dateStr = new Date(emailDate).toISOString().split('T')[0];

		let newCount = 0;

		// 5. Process each image
		for (const emailUrl of imageUrls) {
			try {
				const fallbackChain = buildFallbackChain(emailUrl);
				const { buffer, contentType } = await fetchWithFallback(fallbackChain);

				// Dedup by content hash
				const hash = await sha256(buffer);
				if (existingHashes.has(hash)) {
					console.log(`[image] Duplicate: ${hash.slice(0, 12)}…`);
					continue;
				}

				// Generate ID and store
				const imageId = crypto.randomUUID();
				const ext = inferExtension(contentType);
				const objectKey = `gallery/${imageId}.${ext}`;

				await putObject(config, objectKey, buffer, contentType);

				// Build public URLs via this Worker's proxy
				const publicBase = env.WORKER_PUBLIC_URL
					? env.WORKER_PUBLIC_URL.replace(/\/$/, '')
					: '';
				const src = publicBase ? `${publicBase}/${objectKey}` : `/${objectKey}`;
				const thumb = src;

				// Extract metadata from HTML
				const alt = extractAltText(html, emailUrl) || '';
				const pinUrl = extractPinUrl(html, emailUrl);

				const entry: GalleryImageEntry = {
					id: imageId,
					src,
					thumb,
					alt,
					width: 0,
					height: 0,
					date: dateStr,
					hash,
					sourceUrl: emailUrl,
					pinUrl,
				};

				index.images.unshift(entry);
				existingHashes.add(hash);
				newCount++;

				console.log(
					`[image] Stored: ${objectKey} (${(buffer.byteLength / 1024).toFixed(1)}KB)`,
				);
			} catch (e) {
				console.error(`[image] Failed to process ${emailUrl}: ${e}`);
			}
		}

		// 6. Save updated index
		if (newCount > 0) {
			await putJSON(config, INDEX_KEY, index);
			console.log(
				`[email] Done. Added ${newCount} new images. Total: ${index.images.length}`,
			);

			// 7. Trigger Vercel rebuild (fire-and-forget)
			if (env.VERCEL_DEPLOY_HOOK) {
				ctx.waitUntil(triggerVercelRebuild(env.VERCEL_DEPLOY_HOOK));
			}
		} else {
			console.log('[email] No new images (all duplicates).');
		}

		// 8. Forward to Gmail (optional backup)
		if (env.FORWARD_TO) {
			try {
				await message.forward(env.FORWARD_TO);
			} catch (e) {
				console.error(`[email] Forward failed: ${e}`);
			}
		}
	},
} satisfies ExportedHandler<Env>;

// ── Vercel Deploy Hook ─────────────────────────────────────────────

async function triggerVercelRebuild(hookUrl: string): Promise<void> {
	try {
		const resp = await fetch(hookUrl, { method: 'POST' });
		console.log(`[vercel] Deploy hook response: ${resp.status}`);
	} catch (e) {
		console.error(`[vercel] Deploy hook failed: ${e}`);
	}
}

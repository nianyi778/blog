/**
 * Backblaze B2 storage client via S3-compatible API.
 *
 * Uses aws4fetch for Sig v4 request signing — works in Cloudflare Workers.
 * Provides a minimal interface matching what we need: put object, get object text.
 */
import { AwsClient } from 'aws4fetch';

export interface B2Config {
	endpoint: string; // e.g. https://s3.us-west-004.backblazeb2.com
	bucketName: string;
	keyId: string;
	appKey: string;
}

/**
 * Create a B2 S3 client from environment config.
 */
function createClient(config: B2Config): AwsClient {
	return new AwsClient({
		accessKeyId: config.keyId,
		secretAccessKey: config.appKey,
		service: 's3',
	});
}

/**
 * Build the full S3 URL for a given object key.
 */
function objectUrl(config: B2Config, key: string): string {
	return `${config.endpoint}/${config.bucketName}/${key}`;
}

/**
 * Upload a binary object (image) to B2.
 */
export async function putObject(
	config: B2Config,
	key: string,
	body: ArrayBuffer,
	contentType: string,
): Promise<void> {
	const client = createClient(config);
	const url = objectUrl(config, key);

	const resp = await client.fetch(url, {
		method: 'PUT',
		headers: {
			'Content-Type': contentType,
		},
		body,
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`B2 PUT ${key} failed: ${resp.status} ${text}`);
	}
}

/**
 * Upload a JSON object to B2.
 */
export async function putJSON(
	config: B2Config,
	key: string,
	data: unknown,
): Promise<void> {
	const body = JSON.stringify(data, null, 2);
	const client = createClient(config);
	const url = objectUrl(config, key);

	const resp = await client.fetch(url, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
		},
		body,
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`B2 PUT JSON ${key} failed: ${resp.status} ${text}`);
	}
}

/**
 * Get a JSON object from B2. Returns null if not found.
 */
export async function getJSON<T>(
	config: B2Config,
	key: string,
): Promise<T | null> {
	const client = createClient(config);
	const url = objectUrl(config, key);

	const resp = await client.fetch(url, { method: 'GET' });

	if (resp.status === 404) return null;

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`B2 GET ${key} failed: ${resp.status} ${text}`);
	}

	return (await resp.json()) as T;
}

/**
 * Fetch a raw object from B2 as a Response (for proxying to client).
 * Returns the full Response with body stream, content-type, etc.
 * Returns null if not found (404).
 */
export async function getObject(
	config: B2Config,
	key: string,
): Promise<Response | null> {
	const client = createClient(config);
	const url = objectUrl(config, key);

	const resp = await client.fetch(url, { method: 'GET' });

	if (resp.status === 404) return null;

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`B2 GET ${key} failed: ${resp.status} ${text}`);
	}

	return resp;
}

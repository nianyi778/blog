/**
 * Image download utilities with resolution fallback and content hashing.
 */

export interface FetchResult {
	buffer: ArrayBuffer;
	finalUrl: string;
	contentType: string;
}

const FETCH_HEADERS: Record<string, string> = {
	'User-Agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
	Referer: 'https://www.pinterest.com/',
	Accept: 'image/webp,image/avif,image/*,*/*;q=0.8',
};

/**
 * Fetch an image with fallback through a chain of URLs.
 * Tries each URL in order until one succeeds with a valid image response.
 *
 * @throws Error if all URLs fail
 */
export async function fetchWithFallback(
	fallbackUrls: string[],
): Promise<FetchResult> {
	const errors: string[] = [];

	for (const url of fallbackUrls) {
		try {
			const response = await fetch(url, { headers: FETCH_HEADERS });

			if (!response.ok) {
				errors.push(`${url}: HTTP ${response.status}`);
				continue;
			}

			const contentType = response.headers.get('content-type') || '';
			if (!contentType.startsWith('image/')) {
				errors.push(`${url}: not an image (${contentType})`);
				continue;
			}

			return {
				buffer: await response.arrayBuffer(),
				finalUrl: url,
				contentType,
			};
		} catch (e) {
			errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	throw new Error(
		`All ${fallbackUrls.length} URLs failed:\n${errors.join('\n')}`,
	);
}

/**
 * Compute SHA-256 hash of an ArrayBuffer.
 * Returns lowercase hex string.
 */
export async function sha256(buffer: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Infer file extension from content-type header.
 */
export function inferExtension(contentType: string): string {
	if (contentType.includes('png')) return 'png';
	if (contentType.includes('gif')) return 'gif';
	if (contentType.includes('webp')) return 'webp';
	return 'jpg';
}

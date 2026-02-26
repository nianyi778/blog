/**
 * Pinterest email image URL extraction utilities.
 *
 * Pinterest emails embed images from i.pinimg.com with 236x resolution.
 * We extract those URLs, deduplicate, filter non-content images,
 * and upgrade to the highest available resolution.
 */

/** Regex matching Pinterest CDN image URLs in email HTML */
const PINIMG_REGEX =
	/https:\/\/i\.pinimg\.com\/\d+x\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]+\.\w+/g;

/** Size segments to exclude (avatars, tiny icons) */
const EXCLUDED_SIZES = ['/75x75/', '/75x75_s/'];

/**
 * Extract all Pinterest image URLs from email HTML.
 * Returns deduplicated URLs with non-content images filtered out.
 */
export function extractPinterestImages(html: string): string[] {
	const matches = html.match(PINIMG_REGEX) || [];
	const unique = [...new Set(matches)];

	return unique.filter(
		(url) => !EXCLUDED_SIZES.some((size) => url.includes(size)),
	);
}

/**
 * Upgrade a Pinterest image URL to the highest resolution.
 *
 * Resolution ladder: 75x75 < 170x < 236x < 474x < 736x < originals
 * Email URLs are typically 236x. We upgrade to `originals`.
 */
export function upgradeToOriginal(url: string): string {
	return url.replace(
		/i\.pinimg\.com\/(75x75|75x75_s|170x|236x|474x|736x)/,
		'i.pinimg.com/originals',
	);
}

/**
 * Build a fallback chain for image download.
 * Tries originals first, then progressively lower resolutions.
 *
 * @param emailUrl - The original 236x URL from the email
 * @returns Array of URLs to try in order (highest res first)
 */
export function buildFallbackChain(emailUrl: string): string[] {
	const base = emailUrl.replace(
		/i\.pinimg\.com\/(75x75|75x75_s|170x|236x|474x|736x|originals)/,
		'i.pinimg.com/{SIZE}',
	);

	const sizes = ['originals', '736x', '474x', '236x'];
	const urls: string[] = [];

	for (const size of sizes) {
		const candidate = base.replace('{SIZE}', size);
		if (!urls.includes(candidate)) {
			urls.push(candidate);
		}
	}

	// Always include the original email URL as final fallback
	if (!urls.includes(emailUrl)) {
		urls.push(emailUrl);
	}

	return urls;
}

/**
 * Extract the Pinterest Pin URL from a surrounding <a> tag in email HTML.
 * Returns the pin URL if found, or undefined.
 */
export function extractPinUrl(
	html: string,
	imageUrl: string,
): string | undefined {
	// Look for <a href="...pinterest.com/pin/..."><img src="{imageUrl}">
	const escaped = imageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(
		`<a[^>]+href=["'](https?://(?:www\\.)?pinterest\\.com/pin/[^"']+)["'][^>]*>[^<]*<img[^>]+src=["']${escaped}["']`,
		'i',
	);
	const match = html.match(regex);
	return match?.[1];
}

/**
 * Extract alt text for a specific image URL from email HTML.
 */
export function extractAltText(
	html: string,
	imageUrl: string,
): string | undefined {
	const escaped = imageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(
		`<img[^>]+src=["']${escaped}["'][^>]+alt=["']([^"']*)["']`,
		'i',
	);
	const match = html.match(regex);

	// Also try alt before src
	if (!match) {
		const regex2 = new RegExp(
			`<img[^>]+alt=["']([^"']*)["'][^>]+src=["']${escaped}["']`,
			'i',
		);
		const match2 = html.match(regex2);
		return match2?.[1] || undefined;
	}

	return match?.[1] || undefined;
}

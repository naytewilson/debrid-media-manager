import type { ScrapeSearchResult } from './mediasearch';

export type PlexOnDemandProfile = 'quality' | 'balanced' | 'compatibility';

export type RankedPlexCandidate = ScrapeSearchResult & {
	score: number;
	reasons: string[];
};

const HARD_REJECT = /\b(cam|hdcam|telesync|telecine|workprint|dvdscr|screener|ts[ ._-]?rip|tc[ ._-]?rip)\b/i;

function has(title: string, pattern: RegExp): boolean {
	return pattern.test(title);
}

function sizeScore(bytes: number, profile: PlexOnDemandProfile): number {
	const gib = bytes / (1024 ** 3);
	if (!Number.isFinite(gib) || gib <= 0) return -60;

	if (profile === 'quality') {
		if (gib > 140) return -120;
		if (gib >= 20) return Math.min(180, Math.round(gib * 2));
		return Math.round(gib * 2);
	}

	if (profile === 'balanced') {
		if (gib > 80) return -140;
		if (gib > 50) return -40;
		if (gib >= 8) return 80;
		return Math.round(gib * 4);
	}

	if (gib > 60) return -100;
	if (gib >= 4 && gib <= 35) return 70;
	return 0;
}

export function scorePlexCandidate(
	result: ScrapeSearchResult,
	profile: PlexOnDemandProfile = 'quality'
): RankedPlexCandidate | null {
	const title = result.title || '';
	if (!result.hash || HARD_REJECT.test(title)) return null;

	let score = 0;
	const reasons: string[] = [];

	const add = (points: number, reason: string) => {
		score += points;
		reasons.push(`${points >= 0 ? '+' : ''}${points} ${reason}`);
	};

	if (has(title, /\b2160p\b|\b4k\b/i)) add(360, '2160p');
	else if (has(title, /\b1080p\b/i)) add(190, '1080p');
	else if (has(title, /\b720p\b/i)) add(40, '720p');
	else add(-80, 'unknown resolution');

	if (has(title, /\bremux\b/i)) add(profile === 'quality' ? 420 : 170, 'remux');
	else if (has(title, /\bblu[ ._-]?ray\b|\bbdrip\b/i)) add(230, 'bluray');
	else if (has(title, /\bweb[ ._-]?dl\b/i)) add(profile === 'balanced' ? 230 : 170, 'web-dl');
	else if (has(title, /\bwebrip\b/i)) add(90, 'webrip');
	else if (has(title, /\bhdtv\b/i)) add(20, 'hdtv');

	if (has(title, /\bdolby[ ._-]?vision\b|\b(?:dv|dovi)\b/i)) {
		add(profile === 'compatibility' ? -120 : 150, 'dolby vision');
	}
	if (has(title, /\bhdr10\+\b/i)) add(135, 'hdr10+');
	else if (has(title, /\bhdr10\b/i)) add(110, 'hdr10');
	else if (has(title, /\bhdr\b/i)) add(75, 'hdr');

	if (has(title, /\btruehd\b|\batmos\b/i)) add(95, 'lossless/atmos audio');
	else if (has(title, /\bdts[ ._-]?(?:hd|x)\b/i)) add(75, 'dts-hd/x');
	else if (has(title, /\b(?:ddp|eac3|dd\+)\b/i)) add(35, 'dd+');

	if (has(title, /\b(?:x265|h[ ._-]?265|hevc)\b/i)) add(60, 'hevc');
	else if (has(title, /\bav1\b/i)) add(profile === 'compatibility' ? -140 : 45, 'av1');
	else if (has(title, /\b(?:x264|h[ ._-]?264|avc)\b/i)) add(25, 'avc');

	if (has(title, /\b3d\b|\bsbs\b|\btab\b/i)) add(-180, '3d');
	if (has(title, /\bsample\b/i)) add(-500, 'sample');
	if (has(title, /\bproper\b|\brepack\b/i)) add(15, 'proper/repack');

	add(sizeScore(result.fileSize, profile), 'size fit');

	return { ...result, score, reasons };
}

export function rankPlexCandidates(
	results: ScrapeSearchResult[],
	profile: PlexOnDemandProfile = 'quality'
): RankedPlexCandidate[] {
	return results
		.map((result) => scorePlexCandidate(result, profile))
		.filter((result): result is RankedPlexCandidate => result !== null)
		.sort((a, b) => b.score - a.score || b.fileSize - a.fileSize || a.hash.localeCompare(b.hash));
}

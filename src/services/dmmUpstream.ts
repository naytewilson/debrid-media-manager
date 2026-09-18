import {
	flattenAndRemoveDuplicates,
	isUsableHash,
	type ScrapeSearchResult,
} from './mediasearch';

const FETCH_TIMEOUT_MS = 12_000;
const MAX_PAGES = 2;
const PAGE_RETRY_COUNT = 3;
const PAGE_RETRY_DELAY_MS = 750;

type Challenge = { token?: string; hash?: string };
type MovieResponse = { results?: ScrapeSearchResult[] };
type AvailabilityResponse = {
	available?: Array<{
		hash: string;
		files?: Array<{ file_id: number; path: string; bytes: number }>;
	}>;
};

export type DmmUpstreamMovie = {
	candidates: ScrapeSearchResult[];
	cachedHashes: Set<string>;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function upstreamOrigin(): string | null {
	const raw = process.env.PLEX_ON_DEMAND_UPSTREAM_DMM_ORIGIN?.trim();
	if (!raw || raw === 'off' || raw === 'disabled') return null;
	return raw.replace(/\/+$/, '');
}

async function getChallenge(origin: string, fetchImpl: typeof fetch): Promise<Required<Challenge>> {
	const response = await fetchImpl(`${origin}/api/challenge`, {
		headers: { Accept: 'application/json', 'User-Agent': 'DMM-Plex-On-Demand/1' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`upstream DMM challenge failed: HTTP ${response.status}`);
	const body = (await response.json()) as Challenge;
	if (!body.token || !body.hash) throw new Error('upstream DMM challenge was malformed');
	return { token: body.token, hash: body.hash };
}

async function fetchMoviePage(
	origin: string,
	imdbId: string,
	page: number,
	challenge: Required<Challenge>,
	fetchImpl: typeof fetch
): Promise<ScrapeSearchResult[]> {
	for (let attempt = 0; attempt < PAGE_RETRY_COUNT; attempt++) {
		const url = new URL(`${origin}/api/torrents/movie`);
		url.searchParams.set('imdbId', imdbId);
		url.searchParams.set('dmmProblemKey', challenge.token);
		url.searchParams.set('solution', challenge.hash);
		url.searchParams.set('page', String(page));
		const response = await fetchImpl(url, {
			headers: { Accept: 'application/json', 'User-Agent': 'DMM-Plex-On-Demand/1' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (response.status === 204) {
			if (attempt + 1 < PAGE_RETRY_COUNT) await wait(PAGE_RETRY_DELAY_MS);
			continue;
		}
		if (!response.ok) {
			throw new Error(`upstream DMM movie lookup failed: HTTP ${response.status}`);
		}
		const body = (await response.json()) as MovieResponse;
		return (body.results ?? []).filter(
			(row) =>
				row &&
				typeof row.title === 'string' &&
				typeof row.fileSize === 'number' &&
				isUsableHash(row.hash)
		);
	}
	return [];
}

async function checkAvailability(
	origin: string,
	imdbId: string,
	hashes: string[],
	challenge: Required<Challenge>,
	fetchImpl: typeof fetch
): Promise<Set<string>> {
	const cached = new Set<string>();
	for (let start = 0; start < hashes.length; start += 100) {
		const chunk = hashes.slice(start, start + 100);
		const response = await fetchImpl(`${origin}/api/availability/check`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'User-Agent': 'DMM-Plex-On-Demand/1',
			},
			body: JSON.stringify({
				dmmProblemKey: challenge.token,
				solution: challenge.hash,
				imdbId,
				hashes: chunk,
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`upstream DMM availability failed: HTTP ${response.status}`);
		}
		const body = (await response.json()) as AvailabilityResponse;
		for (const row of body.available ?? []) {
			if (isUsableHash(row.hash)) cached.add(row.hash.toLowerCase());
		}
	}
	return cached;
}

export async function fetchDmmUpstreamMovie(
	imdbId: string,
	fetchImpl: typeof fetch = fetch
): Promise<DmmUpstreamMovie | null> {
	const origin = upstreamOrigin();
	if (!origin) return null;

	const challenge = await getChallenge(origin, fetchImpl);
	const pages: ScrapeSearchResult[][] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const rows = await fetchMoviePage(origin, imdbId, page, challenge, fetchImpl);
		if (rows.length === 0) break;
		pages.push(rows);
		if (rows.length < 50) break;
	}

	const candidates = flattenAndRemoveDuplicates(pages);
	if (candidates.length === 0) {
		return { candidates: [], cachedHashes: new Set() };
	}
	const cachedHashes = await checkAvailability(
		origin,
		imdbId,
		candidates.map((candidate) => candidate.hash),
		challenge,
		fetchImpl
	);
	return { candidates, cachedHashes };
}

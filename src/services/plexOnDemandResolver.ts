import {
	flattenAndRemoveDuplicates,
	type ScrapeSearchResult,
} from './mediasearch';
import { rankPlexCandidates, type PlexOnDemandProfile } from './plexOnDemand';
import {
	addHashAsMagnet,
	deleteTorrent,
	getTorrentInfo,
	selectFiles,
} from './realDebrid';
import { repository as db } from './repository';
import {
	backfillFromDebridioNow,
	refreshDebridioAvailabilityInBackground,
} from '@/utils/debridioBackfill';
import { isVideo } from '@/utils/selectable';

const MAX_ATTEMPTS = 5;
const READY_POLL_COUNT = 10;
const READY_POLL_DELAY_MS = 400;

export type PlexResolveResult =
	| {
			status: 'ready';
			imdbId: string;
			profile: PlexOnDemandProfile;
			hash: string;
			release: string;
			score: number;
			reasons: string[];
			torrentId: string;
			filename: string;
	  }
	| { status: 'no_releases'; imdbId: string }
	| { status: 'no_cached_release'; imdbId: string; candidateCount: number }
	| {
			status: 'failed';
			imdbId: string;
			attempts: Array<{ hash: string; title: string; error: string }>;
	  };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function plexOnDemandProfile(value?: string | null): PlexOnDemandProfile {
	if (value === 'balanced' || value === 'compatibility' || value === 'quality') return value;
	const configured = process.env.PLEX_ON_DEMAND_PROFILE;
	if (configured === 'balanced' || configured === 'compatibility') return configured;
	return 'quality';
}

async function movieCandidates(imdbId: string): Promise<ScrapeSearchResult[]> {
	const key = `movie:${imdbId}`;
	const [trusted, scraped] = await Promise.all([
		db.getAllScrapedTrueResults(key),
		db.getScrapedResults<ScrapeSearchResult[]>(key),
	]);

	let results = flattenAndRemoveDuplicates([
		trusted ?? [],
		(scraped ?? []) as ScrapeSearchResult[],
	]);

	if (results.length === 0) {
		results = await backfillFromDebridioNow({ imdbId, key, kind: 'movie' });
	} else {
		// Await this on the on-demand path so the cache markers used below are
		// fresh before we choose a release.
		await refreshDebridioAvailabilityInBackground({ imdbId, key, kind: 'movie' });
	}

	return results;
}

function pickFeatureFile(files: Array<{ id: number; path: string; bytes: number }>) {
	const videos = files.filter(isVideo);
	const candidates = videos.length > 0 ? videos : files;
	return candidates.reduce<(typeof candidates)[number] | null>(
		(best, file) => (!best || file.bytes > best.bytes ? file : best),
		null
	);
}

async function addCachedCandidate(
	rdToken: string,
	hash: string
): Promise<{ torrentId: string; filename: string }> {
	let torrentId: string | null = null;
	try {
		torrentId = await addHashAsMagnet(rdToken, hash, true);
		let info = await getTorrentInfo(rdToken, torrentId, true);
		const feature = pickFeatureFile(info.files ?? []);
		if (!feature) throw new Error('candidate has no selectable files');

		await selectFiles(rdToken, torrentId, [String(feature.id)], true);

		for (let poll = 0; poll < READY_POLL_COUNT; poll++) {
			info = await getTorrentInfo(rdToken, torrentId, true);
			if (info.status === 'downloaded') {
				return { torrentId, filename: info.filename };
			}
			await wait(READY_POLL_DELAY_MS);
		}
		throw new Error(`candidate did not become instant; status=${info.status}`);
	} catch (error) {
		if (torrentId) await deleteTorrent(rdToken, torrentId, true).catch(() => {});
		throw error;
	}
}

export async function resolvePlexMovie(input: {
	imdbId: string;
	rdToken: string;
	profile?: PlexOnDemandProfile;
}): Promise<PlexResolveResult> {
	const profile = input.profile ?? plexOnDemandProfile();
	const candidates = await movieCandidates(input.imdbId);
	if (candidates.length === 0) {
		return { status: 'no_releases', imdbId: input.imdbId };
	}

	const cached = await db.filterCachedHashes(candidates.map((candidate) => candidate.hash));
	const ranked = rankPlexCandidates(
		candidates.filter((candidate) => cached.has(candidate.hash.toLowerCase())),
		profile
	);
	if (ranked.length === 0) {
		return {
			status: 'no_cached_release',
			imdbId: input.imdbId,
			candidateCount: candidates.length,
		};
	}

	const attempts: Array<{ hash: string; title: string; error: string }> = [];
	for (const candidate of ranked.slice(0, MAX_ATTEMPTS)) {
		try {
			const added = await addCachedCandidate(input.rdToken, candidate.hash);
			return {
				status: 'ready',
				imdbId: input.imdbId,
				profile,
				hash: candidate.hash,
				release: candidate.title,
				score: candidate.score,
				reasons: candidate.reasons,
				torrentId: added.torrentId,
				filename: added.filename,
			};
		} catch (error) {
			attempts.push({
				hash: candidate.hash,
				title: candidate.title,
				error: error instanceof Error ? error.message : 'unknown_error',
			});
		}
	}

	return { status: 'failed', imdbId: input.imdbId, attempts };
}

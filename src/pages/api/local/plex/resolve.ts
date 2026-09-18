import { rankPlexCandidates, type PlexOnDemandProfile } from '@/services/plexOnDemand';
import {
	flattenAndRemoveDuplicates,
	type ScrapeSearchResult,
} from '@/services/mediasearch';
import {
	addHashAsMagnet,
	deleteTorrent,
	getTorrentInfo,
	selectFiles,
} from '@/services/realDebrid';
import { repository as db } from '@/services/repository';
import {
	backfillFromDebridioNow,
	refreshDebridioAvailabilityInBackground,
} from '@/utils/debridioBackfill';
import { isVideo } from '@/utils/selectable';
import type { NextApiHandler } from 'next';

const IMDB_ID = /^tt\d{5,12}$/;
const MAX_ATTEMPTS = 5;
const READY_POLL_COUNT = 10;
const READY_POLL_DELAY_MS = 400;

type ResolveBody = {
	imdbId?: string;
	profile?: PlexOnDemandProfile;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function authorized(req: Parameters<NextApiHandler>[0]): boolean {
	const expected = process.env.PLEX_ON_DEMAND_SECRET;
	if (!expected) return false;
	const auth = req.headers.authorization;
	if (!auth?.startsWith('Bearer ')) return false;
	return auth.slice('Bearer '.length) === expected;
}

function parseProfile(value: unknown): PlexOnDemandProfile {
	if (value === 'balanced' || value === 'compatibility' || value === 'quality') return value;
	const configured = process.env.PLEX_ON_DEMAND_PROFILE;
	if (configured === 'balanced' || configured === 'compatibility') return configured;
	return 'quality';
}

async function movieCandidates(imdbId: string): Promise<ScrapeSearchResult[]> {
	const key = `movie:${imdbId}`;
	const [trusted, scraped] = await Promise.all([
		db.getScrapedTrueResults<ScrapeSearchResult[]>(key),
		db.getScrapedResults<ScrapeSearchResult[]>(key),
	]);

	let results = flattenAndRemoveDuplicates([
		...((trusted ?? []) as ScrapeSearchResult[][]),
		...((scraped ?? []) as ScrapeSearchResult[][]),
	]);

	if (results.length === 0) {
		results = await backfillFromDebridioNow({
			imdbId,
			key,
			kind: 'movie',
		});
	} else {
		await refreshDebridioAvailabilityInBackground({
			imdbId,
			key,
			kind: 'movie',
		});
	}

	return results;
}

async function addCachedCandidate(
	rdToken: string,
	hash: string
): Promise<{ torrentId: string; status: string; filename: string }> {
	let torrentId: string | null = null;
	try {
		torrentId = await addHashAsMagnet(rdToken, hash, true);
		let info = await getTorrentInfo(rdToken, torrentId, true);
		const videoFiles = (info.files ?? []).filter(isVideo);
		const selected = (videoFiles.length > 0 ? videoFiles : info.files ?? []).map((file) =>
			String(file.id)
		);
		if (selected.length === 0) throw new Error('candidate has no selectable files');

		await selectFiles(rdToken, torrentId, selected, true);

		for (let poll = 0; poll < READY_POLL_COUNT; poll++) {
			info = await getTorrentInfo(rdToken, torrentId, true);
			if (info.status === 'downloaded') {
				return {
					torrentId,
					status: info.status,
					filename: info.filename,
				};
			}
			await wait(READY_POLL_DELAY_MS);
		}

		throw new Error(`candidate did not become instant; status=${info.status}`);
	} catch (error) {
		if (torrentId) {
			await deleteTorrent(rdToken, torrentId, true).catch(() => {});
		}
		throw error;
	}
}

const handler: NextApiHandler = async (req, res) => {
	if (req.method !== 'POST') {
		res.setHeader('Allow', 'POST');
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}
	if (!authorized(req)) {
		res.status(401).json({ error: 'unauthorized' });
		return;
	}

	const rdToken = process.env.PLEX_ON_DEMAND_RD_TOKEN;
	if (!rdToken) {
		res.status(503).json({ error: 'resolver_not_configured' });
		return;
	}

	const body = (req.body ?? {}) as ResolveBody;
	const imdbId = typeof body.imdbId === 'string' ? body.imdbId.trim() : '';
	if (!IMDB_ID.test(imdbId)) {
		res.status(400).json({ error: 'invalid_imdb_id' });
		return;
	}
	const profile = parseProfile(body.profile);

	try {
		const candidates = await movieCandidates(imdbId);
		if (candidates.length === 0) {
			res.status(404).json({ error: 'no_releases', imdbId });
			return;
		}

		const cached = await db.filterCachedHashes(candidates.map((candidate) => candidate.hash));
		const ranked = rankPlexCandidates(
			candidates.filter((candidate) => cached.has(candidate.hash.toLowerCase())),
			profile
		);

		if (ranked.length === 0) {
			res.status(409).json({
				error: 'no_cached_release',
				imdbId,
				candidateCount: candidates.length,
			});
			return;
		}

		const attempts: Array<{ hash: string; title: string; error: string }> = [];
		for (const candidate of ranked.slice(0, MAX_ATTEMPTS)) {
			try {
				const added = await addCachedCandidate(rdToken, candidate.hash);
				res.status(200).json({
					status: 'ready',
					imdbId,
					profile,
					hash: candidate.hash,
					release: candidate.title,
					score: candidate.score,
					reasons: candidate.reasons,
					torrentId: added.torrentId,
					filename: added.filename,
				});
				return;
			} catch (error) {
				attempts.push({
					hash: candidate.hash,
					title: candidate.title,
					error: error instanceof Error ? error.message : 'unknown_error',
				});
			}
		}

		res.status(502).json({
			error: 'cached_candidates_failed',
			imdbId,
			attempts,
		});
	} catch (error) {
		console.error(
			'[plex-on-demand] resolve failed',
			error instanceof Error ? error.message : 'unknown error'
		);
		res.status(500).json({ error: 'resolver_failed', imdbId });
	}
};

export default handler;

import { hasLocalCapability } from '@/utils/localCapabilityAuth';
import { fetchPlexWatchlist, removeFromPlexWatchlist } from '@/services/plexWatchlist';
import {
	plexOnDemandState,
	type PlexRequestState,
	type PlexWatchlistState,
} from '@/services/database/plexOnDemandState';
import { plexOnDemandProfile } from '@/services/plexOnDemandResolver';
import { resolvePlexMovie } from '@/services/plexOnDemandResolver';
import type { NextApiHandler } from 'next';

const RETRY_DELAY_MS = 5 * 60 * 1000;
const STALE_RESOLVING_MS = 2 * 60 * 1000;

function nowIso() {
	return new Date().toISOString();
}

function due(item: PlexRequestState, now: number): boolean {
	if (item.status === 'retry') {
		return !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now;
	}
	if (item.status === 'resolving') {
		return Date.parse(item.updatedAt) + STALE_RESOLVING_MS <= now;
	}
	return false;
}

function baselineState(
	items: Awaited<ReturnType<typeof fetchPlexWatchlist>>,
	mode: string
): PlexWatchlistState {
	const initializedAt = nowIso();
	const records: Record<string, PlexRequestState> = {};
	const movies = items.filter((item) => item.type === 'movie');
	const newestRatingKey = mode === 'latest' ? movies[0]?.ratingKey : undefined;

	for (const item of movies) {
		const shouldResolve = mode === 'all' || item.ratingKey === newestRatingKey;
		records[item.ratingKey] = {
			ratingKey: item.ratingKey,
			title: item.title,
			imdbId: item.imdbId,
			status: shouldResolve ? (item.imdbId ? 'retry' : 'unsupported') : 'seen',
			attempts: 0,
			updatedAt: initializedAt,
			nextAttemptAt: shouldResolve && item.imdbId ? initializedAt : undefined,
		};
	}
	return { version: 1, initializedAt, items: records };
}

const handler: NextApiHandler = async (req, res) => {
	if (req.method !== 'POST') {
		res.setHeader('Allow', 'POST');
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}
	if (!hasLocalCapability(req, process.env.PLEX_ON_DEMAND_SECRET)) {
		res.status(401).json({ error: 'unauthorized' });
		return;
	}

	const plexToken = process.env.PLEX_ON_DEMAND_PLEX_TOKEN;
	const rdToken = process.env.PLEX_ON_DEMAND_RD_TOKEN;
	if (!plexToken || !rdToken) {
		res.status(503).json({ error: 'resolver_not_configured' });
		return;
	}

	const accountId = process.env.PLEX_ON_DEMAND_ACCOUNT_ID || 'default';
	const bootstrap = process.env.PLEX_ON_DEMAND_BOOTSTRAP || 'baseline';
	const autoRemove = process.env.PLEX_ON_DEMAND_AUTO_REMOVE === 'true';

	try {
		const watchlist = await fetchPlexWatchlist(plexToken);
		const movies = watchlist.filter((item) => item.type === 'movie');
		const currentKeys = new Set(movies.map((item) => item.ratingKey));

		let state = await plexOnDemandState.get(accountId);
		if (!state) {
			state = baselineState(movies, bootstrap);
			await plexOnDemandState.put(accountId, state);
			if (bootstrap === 'baseline') {
				res.status(200).json({
					status: 'baseline',
					movieCount: movies.length,
					message: 'Existing watchlist captured; new additions will resolve on demand.',
				});
				return;
			}
		}

		// Removal is meaningful: once a ratingKey leaves Plex, forget it. A later
		// re-add becomes a new request instead of being permanently suppressed.
		for (const key of Object.keys(state.items)) {
			if (!currentKeys.has(key)) delete state.items[key];
		}

		for (const item of movies) {
			if (!state.items[item.ratingKey]) {
				state.items[item.ratingKey] = {
					ratingKey: item.ratingKey,
					title: item.title,
					imdbId: item.imdbId,
					status: item.imdbId ? 'retry' : 'unsupported',
					attempts: 0,
					updatedAt: nowIso(),
					nextAttemptAt: item.imdbId ? nowIso() : undefined,
				};
			}
		}

		const now = Date.now();
		const candidate = movies
			.map((item) => state!.items[item.ratingKey])
			.find((item) => item && item.imdbId && due(item, now));

		if (!candidate?.imdbId) {
			await plexOnDemandState.put(accountId, state);
			res.status(200).json({ status: 'idle', movieCount: movies.length });
			return;
		}

		candidate.status = 'resolving';
		candidate.attempts += 1;
		candidate.updatedAt = nowIso();
		delete candidate.nextAttemptAt;
		delete candidate.lastError;
		await plexOnDemandState.put(accountId, state);

		const result = await resolvePlexMovie({
			imdbId: candidate.imdbId,
			rdToken,
			profile: plexOnDemandProfile(),
		});

		if (result.status === 'ready') {
			candidate.status = 'ready';
			candidate.resolvedHash = result.hash;
			candidate.updatedAt = nowIso();
			delete candidate.lastError;
			if (autoRemove) {
				try {
					await removeFromPlexWatchlist(plexToken, candidate.ratingKey);
				} catch (error) {
					candidate.lastError =
						error instanceof Error ? `resolved; watchlist remove failed: ${error.message}` : 'resolved; watchlist remove failed';
				}
			}
			await plexOnDemandState.put(accountId, state);
			res.status(200).json({
				status: 'ready',
				title: candidate.title,
				imdbId: candidate.imdbId,
				hash: result.hash,
				release: result.release,
				filename: result.filename,
			});
			return;
		}

		candidate.status = 'retry';
		candidate.updatedAt = nowIso();
		candidate.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
		candidate.lastError = result.status;
		await plexOnDemandState.put(accountId, state);
		res.status(200).json({
			status: 'retry',
			title: candidate.title,
			imdbId: candidate.imdbId,
			reason: result.status,
			nextAttemptAt: candidate.nextAttemptAt,
		});
	} catch (error) {
		console.error(
			'[plex-on-demand] poll failed',
			error instanceof Error ? error.message : 'unknown error'
		);
		res.status(502).json({ error: 'poll_failed' });
	}
};

export default handler;

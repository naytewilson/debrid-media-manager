import { hasLocalCapability } from '@/utils/localCapabilityAuth';
import {
	plexOnDemandProfile,
	resolvePlexMovie,
} from '@/services/plexOnDemandResolver';
import type { PlexOnDemandProfile } from '@/services/plexOnDemand';
import type { NextApiHandler } from 'next';

const IMDB_ID = /^tt\d{5,12}$/;

type ResolveBody = {
	imdbId?: string;
	profile?: PlexOnDemandProfile;
};

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

	const rdToken = process.env.PLEX_ON_DEMAND_RD_TOKEN;
	if (!rdToken) {
		res.status(503).json({ error: 'resolver_not_configured' });
		return;
	}

	const body = (req.body ?? {}) as ResolveBody;
	const imdbId = typeof body.imdbId === 'string' ? body.imdbId.trim().toLowerCase() : '';
	if (!IMDB_ID.test(imdbId)) {
		res.status(400).json({ error: 'invalid_imdb_id' });
		return;
	}

	try {
		const result = await resolvePlexMovie({
			imdbId,
			rdToken,
			profile: plexOnDemandProfile(body.profile),
		});
		switch (result.status) {
			case 'ready':
				res.status(200).json(result);
				return;
			case 'no_releases':
				res.status(404).json(result);
				return;
			case 'no_cached_release':
				res.status(409).json(result);
				return;
			case 'failed':
				res.status(502).json(result);
				return;
		}
	} catch (error) {
		console.error(
			'[plex-on-demand] resolve failed',
			error instanceof Error ? error.message : 'unknown error'
		);
		res.status(500).json({ error: 'resolver_failed', imdbId });
	}
};

export default handler;

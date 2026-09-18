import { timingSafeEqual } from 'crypto';
import type { NextApiRequest } from 'next';

export function hasLocalCapability(req: NextApiRequest, expected: string | undefined): boolean {
	if (!expected) return false;
	const auth = req.headers.authorization;
	if (!auth?.startsWith('Bearer ')) return false;

	const supplied = auth.slice('Bearer '.length);
	const a = Buffer.from(supplied, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

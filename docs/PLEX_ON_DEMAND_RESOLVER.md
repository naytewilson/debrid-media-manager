# Plex On-Demand Resolver V1

This branch turns the DMM fork into the private resolution brain for the existing Plex + Real-Debrid + Zurg + media-fabric stack.

## Client contract

Plex remains the only user-facing request/playback surface. A title added to the account Watchlist from Apple TV, iPhone/iPad, Mac/Web, or another Plex client enters the same backend flow. Apple TV is the primary acceptance client, but completion requires the published title to behave as an ordinary Plex-library item across clients.

The supported trigger is **Add to Watchlist**. This design does not claim to intercept Plex's Play button for a Discover title that Plex currently considers unavailable.

## Data path

```text
Plex Watchlist
    -> private DMM poll
    -> DMM release corpus + Debridio cache truth
    -> deterministic quality ranking
    -> Real-Debrid add + feature-file selection
    -> Zurg library-update event
    -> media-fabric sync
    -> scoped Plex refresh
    -> normal Plex playback
```

DMM owns Plex cloud auth and Real-Debrid credentials. media-fabric only needs the narrow local bearer capability used to trigger a poll.

## Private endpoints

### `POST /api/local/plex/poll`

Polls the Plex Watchlist once and resolves at most one due movie request. State is persisted in DMM's existing `Cache` table, so restarts do not reset the queue.

The first poll defaults to `baseline`: existing watchlist movies are recorded but not imported. Set `PLEX_ON_DEMAND_BOOTSTRAP=latest` for rollout to resolve only the newest existing movie, or `all` to admit the entire existing movie watchlist gradually.

Removing an item from Plex removes its durable request state on the next poll. Re-adding it is therefore an intentional fresh request.

### `POST /api/local/plex/resolve`

Manual/private discriminator for one movie:

```json
{
  "imdbId": "tt0111161",
  "profile": "quality"
}
```

Both endpoints require:

```text
Authorization: Bearer <PLEX_ON_DEMAND_SECRET>
```

## Release policy

Profiles: `quality`, `balanced`, `compatibility`.

The resolver:

1. reads the complete trusted DMM release row plus current scrape candidates;
2. first-fills/refreshes through DMM's existing Debridio integration where configured;
3. admits only hashes DMM currently records as Real-Debrid cached;
4. stays local-first by default; external DMM corpus fallback is disabled unless `PLEX_ON_DEMAND_UPSTREAM_DMM_ORIGIN` is explicitly set;
5. rejects obvious CAM/telesync/screener sources;
6. scores resolution, source, HDR/DV, audio, codec and DMM-native MiB size;
7. attempts at most five ranked candidates;
8. selects the largest playable video file rather than blindly selecting extras;
9. requires the RD item to become `downloaded` quickly;
10. deletes a failed/non-instant attempt before trying the next candidate.

## Required environment

```text
PLEX_ON_DEMAND_SECRET=<long random secret>
PLEX_ON_DEMAND_PLEX_TOKEN=<server-side Plex token>
PLEX_ON_DEMAND_RD_TOKEN=<server-side Real-Debrid API token>
PLEX_ON_DEMAND_ACCOUNT_ID=default
PLEX_ON_DEMAND_PROFILE=quality
PLEX_ON_DEMAND_BOOTSTRAP=baseline
PLEX_ON_DEMAND_AUTO_REMOVE=false
# Optional external corpus; disabled unless set:
# PLEX_ON_DEMAND_UPSTREAM_DMM_ORIGIN=https://debridmediamanager.com
```

The Plex token is sent to Plex in `X-Plex-Token`, not a query string. The RD token is never accepted from a request body and neither credential is returned by these endpoints.

## Polling behavior

The local trigger may poll frequently for responsive Plex clients, but an unchanged Watchlist poll is read-only after reconciliation and does not rewrite durable state. If Plex Discover responds with HTTP 429, DMM preserves the upstream `Retry-After` as a local 429 so the media-fabric trigger can back off instead of retrying at its normal cadence.

This keeps the request path responsive without converting a temporary Plex throttle into a retry storm.

## Boundary

DMM resolves and admits media. It does not own media-fabric catalog truth or Plex filesystem publication. Zurg's existing library-update hook remains the event that synchronizes media-fabric and performs the scoped Plex refresh.

// DIAL client for the TV's Application-URL (http://<tv>:8080/ws/app/<Name>).
// Wire details follow docs/research/re-deep-links.md (decompiled remote-server DIALAPIService):
// POST only to the singular /ws/app/<Name>, text/plain body ≤ 4096 bytes passed to the app unchanged,
// an Origin header matching the app (verified live 2026-10-21: no Origin → 403, app origin → 201),
// success is 201 + LOCATION, 401 means the TV has not allowed this PC yet. DELETE on the returned
// run location stops the app (200).
import { createQueue } from '../util/queue.js';
import { LumenError } from '../errors.js';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 4096;
const APP_NAME = /^[A-Za-z0-9._-]{1,64}$/;

// DIAL application names, GET-verified on the Q95T.
export const DIAL_APPS = Object.freeze({ youtube: 'YouTube', netflix: 'Netflix', prime: 'AmazonInstantVideo' });

// The Origin the TV's DIAL service accepts for each app (its allowed-origin list is checked with an
// ends-with match against the app's own domain). Launches without one are refused with 403.
export const DIAL_ORIGINS = Object.freeze({
  YouTube: 'https://www.youtube.com', Netflix: 'https://www.netflix.com', AmazonInstantVideo: 'https://www.primevideo.com',
});

// Ranked launch-string candidates per app. The TV hands the body to the app unchanged, so which form
// navigates is up to the app; `config.cast.<app>Payload` picks the index once the live tests decide.
// Each candidate takes the content matched from the link and returns the body, or nothing when the
// link lacks what that form needs.
export const PAYLOADS = Object.freeze({
  youtube: [({ id, t }) => `v=${id}${t > 0 ? `&t=${Math.floor(t)}` : ''}`],
  netflix: [
    ({ id }) => `m=https://www.netflix.com/watch/${id}&source_type=4`,
    ({ id }) => `m=${id}&showMovieInfoOnly=true&source_type_payload=groupIndex%3D1%26tileIndex%3D0%26action%3Dmdp%26movieId%3D${id}`,
    ({ id }) => `m=${id}&source_type=4`,
  ],
  prime: [({ url }) => url, ({ gti }) => gti, ({ gti }) => gti && `gti=${gti}`],
});

// The candidate at `index`, falling back down the ranked list when it cannot be built from `content`.
export function pickPayload(kind, content, index = 0) {
  const candidates = PAYLOADS[kind] ?? [];
  for (const build of [candidates[index], ...candidates]) {
    const body = build?.(content);
    if (body) return body;
  }
  throw new LumenError('INVALID', `That link has nothing ${kind === 'prime' ? 'Prime Video' : kind} can open`);
}

export function createDial({ config, log, store }) {
  const logger = log.child('dial');
  const queue = createQueue({ concurrency: 1, minGapMs: 100 });
  const appUrl = `http://${config.tv.host}:${config.tv.ports.dial ?? 8080}/ws/app/`;
  const abort = new AbortController();
  let stopped = false;

  // → { status, text, location }. `path` defaults to the app itself; the run location adds "/run".
  function request(name, init, path = name) {
    if (!APP_NAME.test(name)) return Promise.reject(new LumenError('INVALID', 'Unknown DIAL app'));
    return queue.push(async () => {
      if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is shutting down');
      const tv = store.get('conn.tv')?.v;
      if (tv === 'standby' || tv === 'off') throw new LumenError('TV_OFF', 'The TV is off');
      const headers = { ...init.headers };
      if (init.method !== 'GET' && DIAL_ORIGINS[name]) headers.Origin = DIAL_ORIGINS[name];
      let res;
      try {
        res = await fetch(appUrl + path, {
          ...init,
          headers,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch (err) {
        logger.debug(`${name} unreachable`, { error: err.message });
        throw new LumenError('UNAVAILABLE', 'The TV app launcher (DIAL) is not reachable');
      }
      // Read the body even when unused so the socket is released; YouTube's carries device ids, never log it.
      const text = await res.text().catch(() => '');
      if (res.status === 404) throw new LumenError('UNAVAILABLE', `${name} is not available on this TV`);
      return { status: res.status, text, location: res.headers.get('location') };
    }, { priority: 'user' });
  }

  return {
    async start() {},
    async stop() {
      stopped = true;
      abort.abort();
    },
    setDemand() {},

    // → { value: 'running' | 'stopped' | 'hidden' | … | null }
    async appState(name) {
      const { status, text } = await request(name, { method: 'GET' });
      if (status < 200 || status >= 300) {
        logger.warn(`${name} state refused`, { status });
        throw new LumenError('FAILED', `The TV refused to query ${name} (HTTP ${status})`);
      }
      return { value: /<state>\s*([^<]*?)\s*<\/state>/.exec(text)?.[1] || null };
    },

    // → { value: { status, location } }
    async launch(name, body = '') {
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        throw new LumenError('INVALID', 'That launch request is too long for the TV (4 KB at most)');
      }
      const { status, location } = await request(name, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset="utf-8"' },
        body,
      });
      if (status >= 200 && status < 300) {
        logger.info(`launched ${name}`, { status });
        return { value: { status, location } };
      }
      logger.warn(`${name} launch refused`, { status });
      switch (status) {
        case 401:
          throw new LumenError('FAILED', `Allow on your TV: the TV is asking whether this PC may open ${name}. Press Allow on the TV, then try again`);
        case 403:
          throw new LumenError('FAILED', `The TV rejected the ${name} launch (origin not accepted)`);
        case 413:
          throw new LumenError('INVALID', 'That launch request is too long for the TV (4 KB at most)');
        case 503:
          throw new LumenError('TV_OFF', 'The TV is in standby; turn it on first');
        default:
          throw new LumenError('FAILED', `The TV refused to launch ${name} (HTTP ${status})`);
      }
    },

    // Stops a DIAL-launched app (the TV advertises allowStop). → { value: { status } }
    async stop(name) {
      const { status } = await request(name, { method: 'DELETE' }, `${name}/run`);
      if (status >= 200 && status < 300) {
        logger.info(`stopped ${name}`, { status });
        return { value: { status } };
      }
      logger.warn(`${name} stop refused`, { status });
      throw new LumenError('FAILED', `The TV refused to stop ${name} (HTTP ${status})`);
    },
  };
}

// Where a film or show streams in India, from JustWatch's public catalogue (no key), mapped onto the
// apps installed on this TV. Used by the AI's play_title / find_title so playing a title does not
// start with a web search and never lands on a rental by accident.
import { LumenError } from '../errors.js';

const ENDPOINT = 'https://apis.justwatch.com/graphql';
const COUNTRY = 'IN';
const TIMEOUT_MS = 10000;
const CACHE_MS = 60 * 60 * 1000;

const QUERY = `query LumenTitles($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, filter: $filter) {
    edges { node { id objectType
      content(country: $country, language: $language) { title originalReleaseYear }
      offers(country: $country, platform: WEB) { monetizationType presentationType standardWebURL package { clearName technicalName } }
    } }
  }
}`;

// JustWatch package → this TV's app. `kind` picks the launch route (deep link where proven).
export const PROVIDERS = {
  netflix: { name: 'Netflix', appIds: ['3201907018807'], skill: 'netflix', kind: 'netflix' },
  jiohotstar: { name: 'JioHotstar', appIds: ['fiZNCxMH9Y.Hotstar'], skill: 'jiohotstar', kind: 'app' },
  hotstar: { name: 'JioHotstar', appIds: ['fiZNCxMH9Y.Hotstar'], skill: 'jiohotstar', kind: 'app' },
  amazonprime: { name: 'Prime Video', appIds: ['3201910019365'], skill: 'prime-video', kind: 'app' },
  amazonprimevideo: { name: 'Prime Video', appIds: ['3201910019365'], skill: 'prime-video', kind: 'app' },
  amazon: { name: 'Prime Video (store)', appIds: ['3201910019365'], skill: 'prime-video', kind: 'app' },
  sonyliv: { name: 'SonyLIV', appIds: ['EUKHUxrGQA.SonyLIV'], skill: 'sonyliv', kind: 'app' },
  airtelxstream: { name: 'Airtel Xstream', appIds: ['dY5YOOBTrj.airtelxstream'], skill: 'airtel-xstream', kind: 'app' },
  airtelxstreamplay: { name: 'Airtel Xstream', appIds: ['dY5YOOBTrj.airtelxstream'], skill: 'airtel-xstream', kind: 'app' },
  appletvplus: { name: 'Apple TV', appIds: ['3201807016597'], skill: 'apple-tv', kind: 'app' },
  itunes: { name: 'Apple TV (store)', appIds: ['3201807016597'], skill: 'apple-tv', kind: 'app' },
  youtube: { name: 'YouTube', appIds: ['111299001912'], skill: 'youtube', kind: 'youtube' },
  plex: { name: 'Plex', appIds: ['3201512006963'], skill: 'plex', kind: 'app' },
};

// Included with a subscription or free; RENT and BUY cost money and are never chosen automatically.
const INCLUDED = new Set(['FLATRATE', 'FREE', 'ADS']);
const RANK = { FLATRATE: 0, FREE: 1, ADS: 2, RENT: 3, BUY: 4 };

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** The content id at the end of a provider URL (Hotstar /1971000669, Netflix /title/70153404, Prime gti=…). */
export function contentIdFrom(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const gti = u.searchParams.get('gti');
    if (gti) return gti;
    const v = u.searchParams.get('v');
    if (v) return v;
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || null;
  } catch {
    return null;
  }
}

export function createTitles({ log, fetchImpl = globalThis.fetch }) {
  const logger = log.child('titles');
  const cache = new Map(); // query → { at, value }

  async function search(query, { first = 6 } = {}) {
    const key = `${norm(query)}|${first}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { country: COUNTRY, language: 'en', first, filter: { searchQuery: query } } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new LumenError('UNAVAILABLE', `The title catalogue did not answer (${err.name === 'TimeoutError' ? 'timeout' : err.message})`);
    }
    if (!res.ok) throw new LumenError('UNAVAILABLE', `The title catalogue answered HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new LumenError('UNAVAILABLE', `The title catalogue refused the query: ${String(json.errors[0].message).slice(0, 120)}`);
    const value = (json.data?.popularTitles?.edges ?? []).map(({ node }) => {
      const offers = new Map();
      for (const o of node.offers ?? []) {
        const tech = o.package?.technicalName;
        const key2 = `${tech}|${o.monetizationType}`;
        if (!tech || offers.has(key2)) continue;
        offers.set(key2, { provider: tech, service: o.package.clearName, monetization: o.monetizationType, url: o.standardWebURL ?? null });
      }
      return {
        title: node.content?.title ?? '',
        year: node.content?.originalReleaseYear ?? null,
        type: node.objectType === 'SHOW' ? 'show' : 'movie',
        offers: [...offers.values()].sort((a, b) => (RANK[a.monetization] ?? 9) - (RANK[b.monetization] ?? 9)),
      };
    });
    cache.set(key, { at: Date.now(), value });
    logger.debug('catalogue search', { query, results: value.length });
    return value;
  }

  /**
   * Finds `title` (optionally `year`, `type`) and decides where to play it on this TV.
   * installedIds: the TV's launchable app ids. preferApp: an app name or id the user asked for.
   * → { match, candidates, choice | null, why }
   */
  async function find(title, { year, type, installedIds = [], preferApp } = {}) {
    const results = await search(title);
    if (!results.length) return { match: null, candidates: [], choice: null, why: 'not-found' };
    const want = norm(title);
    const scored = results.map((r, i) => {
      let score = i; // JustWatch's own popularity order
      if (norm(r.title) === want) score -= 10;
      else if (norm(r.title).startsWith(want) || want.startsWith(norm(r.title))) score -= 4;
      if (year && r.year === Number(year)) score -= 6;
      if (type && r.type === type) score -= 2;
      return { r, score };
    }).sort((a, b) => a.score - b.score);
    const match = scored[0].r;
    const installed = new Set(installedIds);
    const prefer = preferApp ? norm(preferApp) : null;
    const usable = match.offers
      .map((offer) => ({ offer, provider: PROVIDERS[offer.provider] }))
      .filter(({ provider }) => provider && provider.appIds.some((id) => installed.has(id) || installed.size === 0));
    const fits = (p) => !prefer || norm(p.provider.name).includes(prefer) || p.provider.appIds.some((id) => norm(id).includes(prefer));
    const included = usable.filter(({ offer }) => INCLUDED.has(offer.monetization));
    const pick = included.find(fits) ?? (prefer ? null : included[0]);
    const choice = pick ? {
      service: pick.provider.name,
      appId: pick.provider.appIds.find((id) => installed.has(id)) ?? pick.provider.appIds[0],
      skill: pick.provider.skill,
      kind: pick.provider.kind,
      monetization: pick.offer.monetization,
      url: pick.offer.url,
      contentId: contentIdFrom(pick.offer.url),
    } : null;
    let why = 'included';
    if (!choice) why = usable.length ? (prefer && included.length ? 'not-on-requested-app' : 'rent-or-buy-only') : match.offers.length ? 'not-on-installed-apps' : 'not-streaming';
    return { match, candidates: scored.slice(1, 4).map(({ r }) => ({ title: r.title, year: r.year, type: r.type })), choice, why };
  }

  return { search, find, start() {}, stop() {}, setDemand() {} };
}

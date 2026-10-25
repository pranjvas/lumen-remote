// Lumen's browser blocks ads, trackers and pop-under networks itself (features/browser.js): headless
// Edge has no ad blocker of its own and Brave's Shields do not work headless. Each entry is a domain;
// it blocks that host and every host under it (doubleclick.net also blocks ads.g.doubleclick.net).
// The list ships with Lumen and is never downloaded; browser.adBlockExtra in data/config.json adds
// domains, browser.adBlock: false turns blocking off.
//
// Left out on purpose, because pages or players wait on them and break without them (an ad blocker
// with stand-in scripts can block them, Lumen cannot): Google Analytics and Tag Manager (links and
// forms that go on only once the hit is sent), Google's IMA video-ad SDK (players that load it
// before the video), FreeWheel (some broadcasters' players), consent managers, tag managers, A/B
// testing, and link redirectors (affiliate and URL-shortener links would stop working).
import { bareHost } from '../util/addr.js';

const GROUPS = {
  // Google's ad serving and ad measurement (none of its own services).
  google: [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com', 'adservice.google.com',
    'adservice.google.co.in', '2mdn.net', 'dartsearch.net', 'admob.com', 'adsensecustomsearchads.com',
  ],
  // Ad exchanges, ad servers and their bidders (the banners and the auctions behind them).
  exchanges: [
    'amazon-adsystem.com', 'assoc-amazon.com', 'adnxs.com', 'adnxs-simple.com', 'rubiconproject.com', 'pubmatic.com',
    'openx.net', 'casalemedia.com', 'indexww.com', 'criteo.com', 'criteo.net', 'adsrvr.org', 'mathtag.com',
    'bidswitch.net', 'contextweb.com', 'pulsepoint.com', 'sovrn.com', 'lijit.com', 'media.net', 'yieldmo.com',
    'sharethrough.com', 'triplelift.com', '3lift.com', 'smartadserver.com', 'sascdn.com', 'adform.net', 'adition.com',
    'improvedigital.com', '360yield.com', 'smaato.net', 'inner-active.mobi', 'rhythmone.com', '1rx.io', 'gumgum.com',
    'kargo.com', 'undertone.com', 'sonobi.com', '33across.com', 'districtm.io', 'emxdgt.com', 'onetag-sys.com',
    'seedtag.com', 'richaudience.com', 'rtbhouse.com', 'creativecdn.com', 'adkernel.com', 'simpli.fi', 'bidr.io',
    'dotomi.com', 'mookie1.com', 'w55c.net', 'turn.com', 'serving-sys.com', 'flashtalking.com', 'advertising.com',
    'adtechus.com', 'zedo.com', 'yieldmanager.com', 'adroll.com', 'adhese.com', 'adzerk.net', 'yieldlab.net',
    'adscale.de', 'theadex.com', 'e-planning.net', 'adocean.pl', 'admixer.net', 'adriver.ru', 'adfox.ru',
    'an.yandex.ru', 'yandexadexchange.net', 'ads.yahoo.com', 'advertserve.com', 'servedbyadbutler.com', 'buysellads.com',
    'buysellads.net', 'carbonads.com', 'carbonads.net', 'adthrive.com', 'mediavine.com', 'monumetric.com',
    'freestar.com', 'freestar.io', 'venatusmedia.com', 'nitropay.com', 'snigelweb.com', 'cpmstar.com', 'adinplay.com',
    'browsiprod.com', 'bidtellect.com', 'adyoulike.com', 'connexity.net', 'adpushup.com', 'clmbtech.com',
    'andbeyond.media', 'inmobi.com', 'pos.baidu.com', 'cpro.baidu.com', 'tanx.com', 'adblade.com', 'unityads.unity3d.com',
    'vungle.com',
  ],
  // Native ads and "recommended stories" widgets.
  native: [
    'taboola.com', 'outbrain.com', 'zemanta.com', 'revcontent.com', 'mgid.com', 'marketgid.com', 'lentainform.com',
    'adskeeper.com', 'adskeeper.co.uk', 'zergnet.com', 'contentad.net', 'lockerdome.com', 'ntv.io', 'nativo.com',
    'directadvert.ru',
  ],
  // Video-ad servers and outstream video-ad players (the player of the page itself is never here).
  video: [
    'spotxchange.com', 'spotx.tv', 'springserve.com', 'tremorhub.com', 'lkqd.net', 'stickyadstv.com', 'smartclip.net',
    'innovid.com', 'aniview.com', 'vidoomy.com', 'primis.tech', 'vdo.ai', 'unrulymedia.com', 'adtelligent.com', 'teads.tv',
  ],
  // Ad verification and ad-fraud scripts that ride along with the ads.
  verification: [
    'adsafeprotected.com', 'doubleverify.com', 'moatads.com', 'moatpixel.com', 'adlightning.com',
    'confiant-integrations.net', 'geoedge.be', 'fqtag.com',
  ],
  // Pop-under, redirect, in-page push and "smart link" networks: the ones that open ad tabs, cover the
  // player with click-jacking layers or send the page away, on video streaming and adult sites.
  popunder: [
    'popads.net', 'popadscdn.net', 'popcash.net', 'propellerads.com', 'propellerclick.com', 'onclickads.net',
    'onclkds.com', 'oclasrv.com', 'monetag.com', 'propu.sh', 'adsterra.com', 'highperformanceformat.com',
    'hilltopads.net', 'hilltopads.com', 'clickadu.com', 'a-ads.com', 'adcash.com', 'popmyads.com', 'ad-maven.com',
    'revenuehits.com', 'adspyglass.com', 'galaksion.com', 'zeropark.com', 'yllix.com', 'evadav.com', 'richads.com',
    'inpagepush.com', 'clickadilla.com', 'bidvertiser.com', 'infolinks.com', 'clicksor.com', 'adnium.com',
    'adsupply.com', 'pushnami.com', 'notix.io', 'megapu.sh', 'izooto.com', 'dtscout.com',
  ],
  // Ad networks of adult sites (banners, pop-unders and video pre-rolls).
  adult: [
    'exoclick.com', 'exosrv.com', 'exdynsrv.com', 'realsrv.com', 'magsrv.com', 'juicyads.com', 'jads.co',
    'trafficjunky.com', 'trafficjunky.net', 'trafficfactory.biz', 'trafficstars.com', 'tsyndicate.com', 'plugrush.com',
    'ero-advertising.com', 'adxpansion.com', 'clickaine.com', 'twinred.com', 'tubecorporate.com', 'awempire.com',
    'crakrevenue.com', 'trafficforce.com', 'adultadworld.com', 'exoticads.com', 'trafficshop.com', 'trafficholder.com',
  ],
  // Cross-site tracking: audience and identity brokers, retargeting, beacons and session recorders.
  trackers: [
    'scorecardresearch.com', 'quantserve.com', 'quantcount.com', 'imrworldwide.com', 'demdex.net', 'everesttech.net',
    '2o7.net', 'omniture.com', 'bluekai.com', 'krxd.net', 'exelator.com', 'rlcdn.com', 'pippio.com', 'agkn.com',
    'tapad.com', 'crwdcntrl.net', 'eyeota.net', 'liadm.com', 'liveintent.com', 'intentiq.com', 'id5-sync.com',
    'nexac.com', 'acuityplatform.com', 'rfihub.com', 'ipredictive.com', 'ml314.com', 'permutive.com', 'ad.gt',
    'chartbeat.com', 'chartbeat.net', 'hotjar.com', 'hotjar.io', 'clarity.ms', 'mouseflow.com', 'crazyegg.com',
    'luckyorange.com', 'luckyorange.net', 'inspectlet.com', 'fullstory.com', 'smartlook.com', 'statcounter.com',
    'addthis.com', 'sharethis.com', 'bounceexchange.com', 'bouncex.net', 'app-measurement.com', 'hs-analytics.net',
    'hsadspixel.net', 'gemius.pl', 'cnzz.com', 'mmstat.com', 'hm.baidu.com', 'mc.yandex.ru', 'mc.yandex.com',
    'top-fwz1.mail.ru', 'counter.yadro.ru', 'analytics.yahoo.com', 'pixel.wp.com',
  ],
  // The ad and tracking hosts of big sites (never the sites themselves).
  social: [
    'bat.bing.com', 'ads-twitter.com', 'analytics.twitter.com', 'ads.linkedin.com', 'snap.licdn.com',
    'analytics.tiktok.com', 'ct.pinterest.com', 'tr.snapchat.com',
  ],
  // In-page cryptocurrency miners.
  miners: [
    'coinhive.com', 'coin-hive.com', 'authedmine.com', 'crypto-loot.com', 'cryptoloot.pro', 'minero.cc',
    'webminepool.com', 'coinimp.com', 'jsecoin.com',
  ],
};

/** Every bundled domain, in the order above. */
export const AD_DOMAINS = Object.freeze(Object.values(GROUPS).flat());

// Hosts that always load, with everything under them: first-party video and its images and players,
// the CDNs that carry pages' own scripts, sign-in and human checks. An entry (bundled or extra) that is
// one of them, sits under one or above one is dropped.
export const NEVER_BLOCK = Object.freeze([
  'googlevideo.com', 'youtube.com', 'youtube-nocookie.com', 'ytimg.com', 'ggpht.com', 'gstatic.com', 'googleapis.com',
  'googleusercontent.com', 'gvt1.com', 'gvt2.com', 'recaptcha.net', 'hcaptcha.com', 'cloudflare.com', 'cloudfront.net',
  'akamai.net', 'akamaihd.net', 'akamaized.net', 'akamaiedge.net', 'edgekey.net', 'edgesuite.net', 'fastly.net',
  'fastlylb.net', 'jsdelivr.net', 'cdnjs.com', 'unpkg.com', 'azureedge.net', 'azurefd.net', 'b-cdn.net', 'llnwd.net',
  'cdn77.org', 'jwplayer.com', 'jwpcdn.com', 'jwplatform.com', 'vimeo.com', 'vimeocdn.com', 'dailymotion.com',
  'dmcdn.net', 'twitch.tv', 'ttvnw.net', 'jtvnw.net', 'brightcove.com', 'brightcove.net', 'brightcovecdn.com',
  'kaltura.com', 'mux.com', 'bitmovin.com', 'duckduckgo.com',
]);

// Sites whose own pages must load: an entry may name an ad host under them (adservice.google.com), never
// the site itself or a domain above it.
export const KEEP_SITES = Object.freeze([
  'google.com', 'google.co.in', 'bing.com', 'yahoo.com', 'baidu.com', 'yandex.ru', 'yandex.com', 'mail.ru',
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'licdn.com', 'tiktok.com', 'pinterest.com', 'snapchat.com',
  'amazon.com', 'amazon.in', 'microsoft.com', 'unity3d.com', 'wp.com',
]);

const under = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

/**
 * A domain as the list keeps it ("ads.example.com"), from what someone may write in browser.adBlockExtra
 * ("*.Example.com", ".example.com", "https://example.com/path"), or null when it is not one.
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  const d = bareHost(input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d*$/, '')
    .replace(/^\*?\.+/, ''));
  return DOMAIN.test(d) ? d : null;
}

/** Whether the list may hold `domain` (it touches no NEVER_BLOCK host and no KEEP_SITES site). */
export function allowedEntry(domain) {
  return !NEVER_BLOCK.some((p) => under(domain, p) || under(p, domain)) && !KEEP_SITES.some((s) => under(s, domain));
}

/**
 * The block list: the bundled domains plus `extra` (browser.adBlockExtra), each with its subdomains.
 * → { domains, dropped, matches(host), matchesUrl(url), urlPatterns, wildcards }. urlPatterns are
 * Network.setBlockedURLs BlockPatterns (URLPattern syntax: the host and its subdomains, any scheme and
 * port); wildcards are the same hosts as the older wildcard patterns, for an Edge without BlockPattern
 * (they also match an ad address inside another address's query).
 */
export function createAdBlock(extra = []) {
  const set = new Set();
  let dropped = 0;
  for (const raw of [...AD_DOMAINS, ...(Array.isArray(extra) ? extra : [])]) {
    const d = normalizeDomain(raw);
    if (d && allowedEntry(d)) set.add(d);
    else dropped += 1;
  }
  const domains = Object.freeze([...set]);
  function matches(host) {
    let h = bareHost(host);
    for (;;) {
      if (set.has(h)) return true;
      const dot = h.indexOf('.');
      if (dot < 0) return false;
      h = h.slice(dot + 1);
    }
  }
  return {
    domains,
    dropped,
    matches,
    matchesUrl(url) {
      try { return matches(new URL(url).hostname); } catch { return false; }
    },
    urlPatterns: Object.freeze(domains.map((d) => ({ urlPattern: `*://{*.}?${d}:*/*`, block: true }))),
    wildcards: Object.freeze(domains.flatMap((d) => [`*://${d}/*`, `*://${d}:*`, `*.${d}/*`, `*.${d}:*`])),
  };
}

// The ad block list (server/catalog/adblock.js): each domain blocks itself and everything under it,
// extra domains from the config are cleaned up, and first-party video, CDN and sign-in hosts can never
// be blocked, whatever the list or the config says. No browser here: browser-adblock.test.js runs Edge.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AD_DOMAINS, NEVER_BLOCK, KEEP_SITES, createAdBlock, normalizeDomain, allowedEntry } from '../server/catalog/adblock.js';

describe('ad block list', () => {
  test('a few hundred plain domains, each once, none of them left out', () => {
    assert.ok(AD_DOMAINS.length >= 250 && AD_DOMAINS.length <= 600, `${AD_DOMAINS.length} domains`);
    assert.equal(new Set(AD_DOMAINS).size, AD_DOMAINS.length, 'no domain twice');
    for (const d of AD_DOMAINS) assert.equal(normalizeDomain(d), d, `${d} is written as the list keeps it`);
    const list = createAdBlock();
    assert.equal(list.dropped, 0, 'no bundled entry touches a host that must load');
    assert.equal(list.domains.length, AD_DOMAINS.length);
    for (const d of ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'popads.net',
      'popcash.net', 'propellerads.com', 'exoclick.com', 'juicyads.com', 'trafficjunky.net', 'adsterra.com', 'hilltopads.net',
      'clickadu.com', 'a-ads.com', 'onclickads.net']) assert.ok(list.matches(d), `${d} is on the list`);
  });

  test('a domain blocks itself and every host under it, and nothing that only looks like it', () => {
    const { matches, matchesUrl } = createAdBlock();
    assert.ok(matches('doubleclick.net'));
    assert.ok(matches('googleads.g.doubleclick.net'));
    assert.ok(matches('A.B.PopAds.NET.'), 'any case, a trailing dot');
    assert.ok(matches('ads.yahoo.com'));
    assert.equal(matches('notdoubleclick.net'), false);
    assert.equal(matches('doubleclick.net.example.com'), false);
    assert.equal(matches('yahoo.com'), false, 'the site itself, when only its ad host is listed');
    assert.equal(matches('www.yahoo.com'), false);
    assert.equal(matches(''), false);
    assert.equal(matches(null), false);
    assert.ok(matchesUrl('https://tpc.googlesyndication.com:8443/safeframe/x.html?y=1'));
    assert.equal(matchesUrl('https://cdn.example.com/x.gif?ref=https://ads.doubleclick.net/'), false, 'an ad address in the query is not the host');
    assert.equal(matchesUrl('not a url'), false);
  });

  test('never blocks first-party video, its images and players, CDNs, sign-in or the big sites themselves', () => {
    const { matches } = createAdBlock();
    const mustLoad = [
      'rr3---sn-a5mekn6s.googlevideo.com', 'www.youtube.com', 'm.youtube.com', 'i.ytimg.com', 'yt3.ggpht.com', 'www.youtube-nocookie.com',
      'www.gstatic.com', 'fonts.googleapis.com', 'imasdk.googleapis.com', 'lh3.googleusercontent.com', 'www.google.com',
      'accounts.google.com', 'www.google.co.in', 'www.google-analytics.com', 'www.googletagmanager.com', 'www.recaptcha.net',
      'd2abcdefg.cloudfront.net', 'a1.akamaihd.net', 'x.akamaized.net', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com',
      'challenges.cloudflare.com', 'unpkg.com', 'player.vimeo.com', 'f.vimeocdn.com', 'www.dailymotion.com', 's1.dmcdn.net',
      'www.twitch.tv', 'video-weaver.ttvnw.net', 'ssl.p.jwpcdn.com', 'players.brightcove.net', 'stream.mux.com',
      'hcaptcha.com', 'duckduckgo.com', 'www.bing.com', 'www.facebook.com', 'connect.facebook.net', 'static.licdn.com',
      'www.linkedin.com', 'www.amazon.in', 'www.microsoft.com', 's0.wp.com', 'abs.twimg.com', 'x.com',
    ];
    for (const host of mustLoad) assert.equal(matches(host), false, `${host} must load`);
    for (const d of AD_DOMAINS) {
      for (const p of NEVER_BLOCK) assert.ok(d !== p && !d.endsWith(`.${p}`) && !p.endsWith(`.${d}`), `${d} touches ${p}`);
      for (const s of KEEP_SITES) assert.ok(d !== s && !s.endsWith(`.${d}`), `${d} would block the site ${s}`);
    }
  });

  test('extra domains from the config: written any common way, and never one that would block a host that must load', () => {
    assert.equal(normalizeDomain('*.Ads.Example.org'), 'ads.example.org');
    assert.equal(normalizeDomain('.tracker.example'), 'tracker.example');
    assert.equal(normalizeDomain('https://pop.example.net:8443/x?y#z'), 'pop.example.net');
    assert.equal(normalizeDomain(' ads.example.com. '), 'ads.example.com');
    for (const bad of ['', 'com', 'not a domain', 'exa mple.com', '-bad.example', '[::1]', 42, null]) assert.equal(normalizeDomain(bad), null, String(bad));
    assert.equal(allowedEntry('googlevideo.com'), false);
    assert.equal(allowedEntry('r1.googlevideo.com'), false, 'under a host that must load');
    assert.equal(allowedEntry('com'), false, 'above every host');
    assert.equal(allowedEntry('google.com'), false, 'a big site itself');
    assert.equal(allowedEntry('ads.google.com'), true, 'an ad host under a big site');
    const list = createAdBlock(['*.Extra-Ads.example', 'googlevideo.com', 'cloudfront.net', 'not a domain', 'popads.net']);
    assert.ok(list.matches('x.extra-ads.example'));
    assert.equal(list.matches('rr1.googlevideo.com'), false);
    assert.equal(list.dropped, 3, 'googlevideo.com, cloudfront.net and the non-domain');
    assert.equal(list.domains.length, AD_DOMAINS.length + 1, 'popads.net is there once');
    assert.equal(createAdBlock('not a list').domains.length, AD_DOMAINS.length);
  });

  test("Edge's block patterns: one URL pattern per domain (it and its subdomains, any scheme and port), four wildcards as the fallback", () => {
    const list = createAdBlock();
    assert.equal(list.urlPatterns.length, list.domains.length);
    assert.deepEqual(list.urlPatterns.find((p) => p.urlPattern.includes('popads.net')), { urlPattern: '*://{*.}?popads.net:*/*', block: true });
    for (const { urlPattern } of list.urlPatterns) assert.match(urlPattern, /^\*:\/\/\{\*\.\}\?[a-z0-9.-]+:\*\/\*$/);
    assert.equal(list.wildcards.length, list.domains.length * 4);
    assert.deepEqual(list.wildcards.filter((w) => w.includes('//popads.net') || w.includes('.popads.net')),
      ['*://popads.net/*', '*://popads.net:*', '*.popads.net/*', '*.popads.net:*']);
  });
});

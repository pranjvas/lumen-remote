// Clear history (Browser view → hub browser.clearHistory): everything Lumen keeps about the pages its
// browser showed. features/browser.js clears Edge's own data and the page state; this adds what the
// rest of Lumen remembers: the TV screen's last pages and videos, the relay's stream addresses, the
// converted videos, and the page addresses and site names in Lumen's logs (data/logs: lumen.log,
// stdout.log and their rotated copies).
import fs from 'node:fs';
import path from 'node:path';

// Log tags (their first part, before ':') whose lines can name a page or a site.
const BROWSING_TAGS = new Set(['browser', 'tvscreen', 'relay', 'transcode', 'cast', 'livevideo', 'vpn', 'vpn-proxy']);
// Fields of those lines that name a page, a site or a page's title: their values go.
const PLACE_KEYS = new Set(['url', 'host', 'hostname', 'href', 'origin', 'referer', 'from', 'to', 'registered', 'resolved', 'stream', 'dest', 'target', 'page', 'link', 'title']);
const CLEARED = '[cleared]';
const CLEAR_HISTORY = Object.freeze({ tags: BROWSING_TAGS, keys: PLACE_KEYS, mark: CLEARED });
// Incognito (features/incognito.js): lines written while it is on name no page, site or title at all,
// and Ask Lumen's lines keep neither the request nor the reply nor a tool's summary (they can quote
// the page). Lines of other features keep their own text with every outside web address masked.
const INCOGNITO = Object.freeze({
  tags: new Set([...BROWSING_TAGS, 'ai', 'ai-api', 'ai-sdk', 'mcp']),
  keys: new Set([...PLACE_KEYS, 'text', 'reply', 'summary']),
  mark: '[incognito]',
});
// A lumen.log line (ISO time) or a stdout.log line (console time): time, level, [tag], message, JSON.
const LINE = /^(?<head>(?:\S+\s+)?(?:DEBUG|INFO|WARN|ERROR)\s+)\[(?<tag>[^\]]+)\] (?<rest>.*)$/;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>\\]+/gi;
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const FILE_NAME = /\.(?:js|mjs|json|html|css|log|m3u8|mpd|ts|mp4|webm|png|jpe?g|wgt|exe|dll)$/i;
const LOG_FILE = /\.log(?:\.\d+)?$/i;

// This PC and the home network (Lumen's own listeners, the TV) are not browsing history.
const isPrivateHost = (host) => /^(?:localhost$|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[?::1\]?$)/i.test(host);

/** Web addresses in `text`: on another site → [url]; on this PC or the home network → scheme://host/… */
export function maskUrls(text) {
  return String(text).replace(URL_RE, (url) => {
    const [whole, scheme, authority] = url.match(/^([a-z]+:\/\/)([^/?#]*)/i);
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    if (!isPrivateHost(host.replace(/:\d+$/, ''))) return '[url]';
    return `${scheme}${host}${url.length > whole.length + 1 ? '/…' : url.slice(whole.length)}`;
  });
}

// Addresses, site names and public IP addresses in a browsing line's text.
function maskPlaces(text) {
  return maskUrls(text)
    .replace(HOST_RE, (name) => (FILE_NAME.test(name) ? name : '[host]'))
    .replace(IPV4_RE, (ip) => (isPrivateHost(ip) ? ip : '[ip]'));
}

function scrubValue(value, key, rules) {
  if (key !== undefined && rules.keys.has(key) && value !== null && value !== undefined && value !== '') return rules.mark;
  if (typeof value === 'string') return maskPlaces(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, undefined, rules));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, k, rules)]));
  return value;
}

/**
 * One log line without browsing history: in lines from the browser and the features around it
 * ([browser], [tvscreen], [relay], [transcode], [cast], [livevideo], the VPN proxy) every page, site
 * and title field is cleared and addresses or site names in the text are masked; in every other line
 * web addresses outside this PC and the home network are masked. Everything else stays as it was.
 */
export function scrubLine(line, rules = CLEAR_HISTORY) {
  const cr = line.endsWith('\r') ? '\r' : '';
  const body = cr ? line.slice(0, -1) : line;
  const m = LINE.exec(body);
  if (!m || !rules.tags.has(m.groups.tag.split(':')[0])) {
    const out = maskUrls(body);
    return out === body ? line : out + cr;
  }
  const { head, tag, rest } = m.groups;
  const brace = rest.indexOf(' {');
  const message = brace >= 0 ? rest.slice(0, brace) : rest;
  let extra = brace >= 0 ? rest.slice(brace + 1) : '';
  if (extra) {
    try {
      extra = JSON.stringify(scrubValue(JSON.parse(extra), undefined, rules));
    } catch {
      // Not JSON (cut short, or unserialisable): clear the place fields by pattern instead.
      extra = maskPlaces(extra.replace(/"([\w-]+)":"(?:[^"\\]|\\.)*"/g, (all, key) => (rules.keys.has(key) ? `"${key}":"${rules.mark}"` : all)));
    }
  }
  const out = `${head}[${tag}] ${maskPlaces(message)}${extra ? ` ${extra}` : ''}`;
  return out === body ? line : out + cr;
}

/** A log line as Lumen writes it while the browser is incognito (scrubLine with the INCOGNITO rules). */
export const incognitoLine = (line) => scrubLine(line, INCOGNITO);

/**
 * Rewrites every log file in `dir` (*.log and rotated *.log.N) through scrubLine. Files are rewritten
 * in place, not replaced: another process can hold one open for appending (stdout.log is the server's
 * own output when tools/start-hidden.js started it), and its next lines land after the scrubbed text.
 * → { files, lines } changed.
 */
export function scrubLogs(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return { files: 0, lines: 0 }; }
  let files = 0;
  let lines = 0;
  for (const name of names) {
    if (!LOG_FILE.test(name)) continue;
    const file = path.join(dir, name);
    let text;
    try {
      if (!fs.statSync(file).isFile()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let changed = 0;
    const out = text.split('\n').map((line) => {
      const next = scrubLine(line);
      if (next !== line) changed += 1;
      return next;
    }).join('\n');
    if (!changed) continue;
    const bytes = Buffer.from(out, 'utf8');
    const fd = fs.openSync(file, 'r+');
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    files += 1;
    lines += changed;
  }
  return { files, lines };
}

export function createHistory({ config, log: rootLog, features }) {
  const log = rootLog.child('history');
  const logDir = path.join(config.dataDir, 'logs');
  let running = null;

  async function run({ history, cache, cookies }) {
    const result = { history, cache, cookies, removed: 0, left: [], restarted: false };
    if (history) {
      // Before the browser clears (and may start again for the TV, whose new frames must stay): the TV
      // screen's memory. A video the TV is playing now keeps its stream and conversion until it ends.
      const inUse = features.tvscreen?.forgetHistory?.() ?? { videoOnTv: false, job: null };
      result.streams = inUse.videoOnTv ? 0 : features.relay?.forget?.() ?? 0;
      result.conversions = features.transcode?.clearSaved?.({ keep: inUse.job ? [inUse.job] : [] }) ?? 0;
    }
    if (features.browser?.clearHistory) Object.assign(result, await features.browser.clearHistory({ history, cache, cookies }));
    if (history) {
      let logs = { files: 0, lines: 0 };
      try {
        logs = scrubLogs(logDir);
      } catch (err) {
        log.warn('the logs could not all be cleared', { code: err.code });
      }
      rootLog.reopen?.(); // the log file was rewritten under the logger: it counts its size again
      result.logLines = logs.lines;
    }
    log.info('cleared', { history, cache, cookies, removed: result.removed, left: result.left.length, logLines: result.logLines ?? 0 });
    return { value: result };
  }

  /** Clears the chosen kinds of browsing data (one clear at a time). */
  async function clear({ history = true, cache = true, cookies = false } = {}) {
    while (running) await running.catch(() => {});
    running = run({ history, cache, cookies });
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  return { clear, setDemand() {} };
}

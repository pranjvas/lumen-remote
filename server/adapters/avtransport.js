// DLNA renderer client: AVTransport + ConnectionManager SOAP on the TV's DMR (port 9197).
// Wire details follow docs/research/re-dlna-cast.md (live SCPDs + the decompiled DLNA reader).
import { createQueue } from '../util/queue.js';
import { LumenError } from '../errors.js';

const SERVICES = {
  avt: { urn: 'urn:schemas-upnp-org:service:AVTransport:1', path: '/upnp/control/AVTransport1' },
  cm: { urn: 'urn:schemas-upnp-org:service:ConnectionManager:1', path: '/upnp/control/ConnectionManager1' },
};

// 4th protocolInfo field / contentFeatures.dlna.org. OP=01 is byte-range seek only (the TV turns a
// Seek into a new ranged GET). Images use the interactive-transfer flags, video and audio streaming.
export const DLNA_FLAGS = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
export const DLNA_IMAGE_FLAGS = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=00F00000000000000000000000000000';

// UPnP faults that pass on their own: 705 "Transport is locked" right after SetAVTransportURI,
// 701 "Transition not available" while the renderer is still TRANSITIONING or just after a Seek.
export const TRANSIENT_UPNP_CODES = Object.freeze([701, 705]);

const REQUEST_TIMEOUT_MS = 6000;

export const isImage = (mime) => /^image\//i.test(mime);
export const dlnaFeatures = (mime) => (isImage(mime) ? DLNA_IMAGE_FLAGS : DLNA_FLAGS);

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

// Single pass, so "&amp;lt;" decodes to "&lt;" (not "<").
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (whole, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

// "1:02:03", "01:02:03.500" → seconds; "", "NOT_IMPLEMENTED" → null.
export function parseTime(text) {
  const m = /^(\d+):([0-5]?\d):([0-5]?\d)(?:\.(\d+))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return m[4] ? seconds + Number(`0.${m[4]}`) : seconds;
}

// H:MM:SS, the form the TV itself uses ("0:00:05").
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export function upnpClass(mime) {
  if (/^audio\//i.test(mime)) return 'object.item.audioItem.musicTrack';
  if (isImage(mime)) return 'object.item.imageItem.photo';
  return 'object.item.videoItem.movie';
}

export function protocolInfo(mime) {
  return `http-get:*:${mime}:${dlnaFeatures(mime)}`;
}

// DIDL-Lite with values escaped once; soap() escapes the whole document again inside CurrentURIMetaData.
export function buildDidl({ uri, title, mime }) {
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/"'
    + ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">'
    + '<item id="0" parentID="-1" restricted="1">'
    + `<dc:title>${escapeXml(title)}</dc:title>`
    + `<upnp:class>${upnpClass(mime)}</upnp:class>`
    + `<res protocolInfo="${escapeXml(protocolInfo(mime))}">${escapeXml(uri)}</res>`
    + '</item></DIDL-Lite>';
}

export function buildEnvelope(urn, action, args) {
  const body = Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join('');
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${urn}">${body}</u:${action}></s:Body></s:Envelope>`;
}

// Child elements of <u:ActionResponse>, entity-decoded once and trimmed (the TV appends newlines).
export function parseResponse(xml, action) {
  const outer = new RegExp(`<(?:[\\w-]+:)?${action}Response\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${action}Response>`).exec(xml);
  if (!outer) return {};
  const fields = {};
  for (const m of outer[1].matchAll(/<([\w-]+)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    fields[m[1]] = decodeEntities(m[2] ?? '').trim();
  }
  return fields;
}

function parseFault(xml) {
  const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/.exec(xml)?.[1];
  const description = /<errorDescription>([^<]*)<\/errorDescription>/.exec(xml)?.[1]?.trim();
  return { code: code ? Number(code) : null, description: description ? decodeEntities(description) : null };
}

function titleFromDidl(didl) {
  const m = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(didl ?? '');
  return m ? decodeEntities(m[1]).trim() || null : null;
}

export function createAvTransport({ config, log, store }) {
  const logger = log.child('avtransport');
  const queue = createQueue({ concurrency: 1, minGapMs: 200 });
  const base = `http://${config.tv.host}:${config.tv.ports.dmr}`;
  const abort = new AbortController();
  let stopped = false;

  function soap(service, action, args = {}, priority = 'user') {
    const { urn, path } = SERVICES[service];
    return queue.push(async () => {
      if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is shutting down');
      const tv = store.get('conn.tv')?.v;
      if (tv === 'standby' || tv === 'off') throw new LumenError('TV_OFF', 'The TV is off');
      let res, text;
      try {
        res = await fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${urn}#${action}"` },
          body: buildEnvelope(urn, action, args),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        text = await res.text();
      } catch (err) {
        logger.debug(`${action} unreachable`, { error: err.message });
        throw new LumenError('UNAVAILABLE', 'The TV media renderer is not reachable');
      }
      if (!res.ok) {
        const fault = parseFault(text);
        const transient = TRANSIENT_UPNP_CODES.includes(fault.code);
        logger[transient ? 'debug' : 'warn'](`${action} refused`, { status: res.status, ...fault });
        const detail = fault.description ? `${fault.description}${fault.code ? ` (${fault.code})` : ''}` : `HTTP ${res.status}`;
        const err = new LumenError('FAILED', `The TV refused ${action}: ${detail}`);
        err.upnp = fault; // callers retry the transient codes
        throw err;
      }
      return parseResponse(text, action);
    }, { priority });
  }

  const avt = (action, args = {}, priority) => soap('avt', action, { InstanceID: 0, ...args }, priority);

  async function readTransport(priority) {
    const f = await avt('GetTransportInfo', {}, priority);
    return { value: { state: f.CurrentTransportState || null, status: f.CurrentTransportStatus || null, speed: f.CurrentSpeed || null } };
  }

  async function readPosition(priority) {
    const f = await avt('GetPositionInfo', {}, priority);
    const duration = parseTime(f.TrackDuration);
    return {
      value: {
        track: f.Track ? Number(f.Track) : null,
        position: parseTime(f.RelTime),
        duration: duration > 0 ? duration : null,
        uri: f.TrackURI || null,
      },
    };
  }

  return {
    async start() {},
    // Lifecycle stop: never touches playback on the TV.
    async stop() {
      stopped = true;
      abort.abort();
    },
    setDemand() {},

    // metadata: a DIDL-Lite string, or { title?, mime? } to build one.
    async setUri(uri, metadata = {}) {
      const didl = typeof metadata === 'string'
        ? metadata
        : buildDidl({ uri, title: metadata.title || 'Lumen', mime: metadata.mime || 'video/mp4' });
      await avt('SetAVTransportURI', { CurrentURI: uri, CurrentURIMetaData: didl });
      return {};
    },
    // Speed 1 only: the TV's reader sends PlaySpeed.dlna.org only when the server advertises DLNA.ORG_PS.
    async play() {
      await avt('Play', { Speed: 1 });
      return readTransport();
    },
    async pause() {
      await avt('Pause');
      return readTransport();
    },
    // The SOAP Stop action; named apart from the lifecycle stop() every adapter has.
    async stopPlayback() {
      await avt('Stop');
      return readTransport();
    },
    async seek(seconds) {
      await avt('Seek', { Unit: 'REL_TIME', Target: formatTime(seconds) });
      return readPosition();
    },
    getTransportInfo: (priority = 'user') => readTransport(priority),
    getPositionInfo: (priority = 'user') => readPosition(priority),
    async getMediaInfo(priority = 'user') {
      const f = await avt('GetMediaInfo', {}, priority);
      const duration = parseTime(f.MediaDuration);
      return {
        value: {
          tracks: f.NrTracks ? Number(f.NrTracks) : 0,
          duration: duration > 0 ? duration : null,
          uri: f.CurrentURI || null,
          title: titleFromDidl(f.CurrentURIMetaData),
          medium: f.PlayMedium || null,
        },
      };
    },
    // Samsung's X_GetStoppedReason: why the last cast ended (values are still being collected live).
    async getStoppedReason(priority = 'user') {
      const f = await avt('X_GetStoppedReason', {}, priority);
      return { value: { reason: f.StoppedReason || null, data: f.StoppedReasonData || null } };
    },
    async getProtocolInfo(priority = 'user') {
      const f = await soap('cm', 'GetProtocolInfo', {}, priority);
      const split = (s) => (s ? s.split(',').map((p) => p.trim()).filter(Boolean) : []);
      return { value: { sink: split(f.Sink), source: split(f.Source) } };
    },
  };
}

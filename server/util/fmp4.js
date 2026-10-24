// Fragmented MP4 for Lumen's live video of its browser (features/livevideo.js): an init segment
// (ftyp + moov with one H.264 or HEVC video track and an optional AAC track) and one moof + mdat per
// sample, which MSE on the TV appends as they arrive. Also the codec configuration records: H.264's
// avcC comes from the encoder; HEVC's hvcC is built here from the VPS/SPS/PPS of an Annex B frame.

export const VIDEO_TRACK = 1;
export const AUDIO_TRACK = 2;
export const VIDEO_TIMESCALE = 90000;

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.max(0, Math.round(v)))); return b; };
const zeros = (n) => Buffer.alloc(n);
const str4 = (s) => Buffer.from(s, 'latin1');

function box(type, ...parts) {
  const body = Buffer.concat(parts.flat());
  return Buffer.concat([u32(8 + body.length), str4(type), body]);
}
const fullbox = (type, version, flags, ...parts) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts);
const MATRIX = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

// ---------- codec strings ----------

/** 'avc1.PPCCLL' from an avcC record (AVCDecoderConfigurationRecord). */
export function avcCodecString(avcC) {
  const hex = (v) => v.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

/** 'hvc1.<profile>.<compat>.<tier><level>[.<constraints>]' (ISO/IEC 14496-15 Annex E) from an hvcC record. */
export function hevcCodecString(hvcC, entry = 'hvc1') {
  const space = hvcC[1] >> 6;
  const tier = (hvcC[1] >> 5) & 1;
  const profile = hvcC[1] & 0x1f;
  let compat = hvcC.readUInt32BE(2);
  let reversed = 0;
  for (let i = 0; i < 32; i++) { reversed = (reversed << 1) | (compat & 1); compat >>>= 1; }
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  const parts = [entry, `${space ? 'ABC'[space - 1] : ''}${profile}`, (reversed >>> 0).toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${hvcC[12]}`,
    ...constraints.map((c) => c.toString(16).toUpperCase())];
  return parts.join('.');
}

// ---------- Annex B ----------

/** The NAL units of an Annex B buffer (start codes removed). */
export function splitAnnexB(buf) {
  const units = [];
  let i = 0;
  let start = -1;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) units.push(trimZeros(buf.subarray(start, i)));
      i += 3;
      start = i;
    } else i += 1;
  }
  if (start >= 0) units.push(buf.subarray(start));
  else if (buf.length) units.push(buf); // no start code: one bare unit
  return units.filter((u) => u.length);
}
function trimZeros(b) { let end = b.length; while (end > 0 && b[end - 1] === 0) end -= 1; return b.subarray(0, end); }

/** NAL units → 4-byte length-prefixed sample data. */
export function lengthPrefixed(units) {
  return Buffer.concat(units.flatMap((u) => [u32(u.length), u]));
}

export const hevcNalType = (unit) => (unit[0] >> 1) & 0x3f;
const HEVC_VPS = 32, HEVC_SPS = 33, HEVC_PPS = 34, HEVC_AUD = 35;
export const HEVC_PARAMETER_SETS = new Set([HEVC_VPS, HEVC_SPS, HEVC_PPS, HEVC_AUD]);

// RBSP (emulation prevention bytes removed) bit reader with Exp-Golomb.
function bitReader(unit) {
  const bytes = [];
  for (let i = 0; i < unit.length; i++) {
    if (i >= 2 && unit[i] === 3 && unit[i - 1] === 0 && unit[i - 2] === 0) continue;
    bytes.push(unit[i]);
  }
  let pos = 0;
  const bit = () => { const b = (bytes[pos >> 3] >> (7 - (pos & 7))) & 1; pos += 1; return b; };
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
  const ue = () => { let z = 0; while (bit() === 0 && z < 32) z += 1; return 2 ** z - 1 + bits(z); };
  return { bits, ue, skip: (n) => { pos += n; }, bytesAt: (n) => Buffer.from(bytes.slice(pos >> 3, (pos >> 3) + n)) };
}

/** Fields of an HEVC SPS that hvcC repeats. */
export function parseHevcSps(sps) {
  const r = bitReader(sps);
  r.skip(16); // NAL header
  r.skip(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.bits(3);
  const temporalIdNesting = r.bits(1);
  const ptl = r.bytesAt(12); // general profile_tier_level: 2+1+5 bits, 32 compat flags, 48 constraint bits, level
  r.skip(96);
  const subProfile = [];
  const subLevel = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) { subProfile.push(r.bits(1)); subLevel.push(r.bits(1)); }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) { if (subProfile[i]) r.skip(88); if (subLevel[i]) r.skip(8); }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormat = r.ue();
  if (chromaFormat === 3) r.skip(1);
  const width = r.ue();
  const height = r.ue();
  if (r.bits(1)) { r.ue(); r.ue(); r.ue(); r.ue(); } // conformance window
  const bitDepthLuma = r.ue() + 8;
  const bitDepthChroma = r.ue() + 8;
  return { ptl, maxSubLayersMinus1, temporalIdNesting, chromaFormat, width, height, bitDepthLuma, bitDepthChroma };
}

/** hvcC (HEVCDecoderConfigurationRecord) from the VPS, SPS and PPS units, or null without them. */
export function buildHvcC(units) {
  const vps = units.filter((u) => hevcNalType(u) === HEVC_VPS);
  const sps = units.filter((u) => hevcNalType(u) === HEVC_SPS);
  const pps = units.filter((u) => hevcNalType(u) === HEVC_PPS);
  if (!vps.length || !sps.length || !pps.length) return null;
  const info = parseHevcSps(sps[0]);
  const arrays = [[HEVC_VPS, vps], [HEVC_SPS, sps], [HEVC_PPS, pps]].map(([type, list]) =>
    Buffer.concat([u8(0x80 | type), u16(list.length), ...list.flatMap((u) => [u16(u.length), u])]));
  return Buffer.concat([
    u8(1), info.ptl,
    u16(0xf000), u8(0xfc), u8(0xfc | (info.chromaFormat & 3)),
    u8(0xf8 | ((info.bitDepthLuma - 8) & 7)), u8(0xf8 | ((info.bitDepthChroma - 8) & 7)),
    u16(0), u8((((info.maxSubLayersMinus1 + 1) & 7) << 3) | (info.temporalIdNesting << 2) | 3),
    u8(arrays.length), ...arrays,
  ]);
}

// ---------- init segment ----------

function visualEntry(video) {
  const kind = video.codec.startsWith('hvc1') || video.codec.startsWith('hev1') ? 'hvcC' : 'avcC';
  const entry = kind === 'hvcC' ? 'hvc1' : 'avc1';
  return box(entry, zeros(6), u16(1), zeros(16), u16(video.width), u16(video.height), u32(0x00480000), u32(0x00480000),
    zeros(4), u16(1), zeros(32), u16(0x0018), u16(0xffff), box(kind, video.config));
}

function esds(audio) {
  const descriptor = (tag, body) => Buffer.concat([u8(tag), u8(body.length), body]);
  const asc = audio.config;
  const decoderSpecific = descriptor(5, asc);
  const decoderConfig = descriptor(4, Buffer.concat([u8(0x40), u8(0x15), zeros(3), u32(audio.bitrate ?? 128000), u32(audio.bitrate ?? 128000), decoderSpecific]));
  const es = descriptor(3, Buffer.concat([u16(AUDIO_TRACK), u8(0), decoderConfig, descriptor(6, u8(2))]));
  return fullbox('esds', 0, 0, es);
}

function audioEntry(audio) {
  return box('mp4a', zeros(6), u16(1), zeros(8), u16(audio.channels), u16(16), zeros(4), u32(audio.sampleRate * 65536), esds(audio));
}

function trak({ id, handler, timescale, width = 0, height = 0, entry }) {
  const isVideo = handler === 'vide';
  return box('trak',
    fullbox('tkhd', 0, 3, zeros(8), u32(id), zeros(4), u32(0), zeros(8), u16(0), u16(0), u16(isVideo ? 0 : 0x0100), zeros(2), MATRIX, u32(width * 65536), u32(height * 65536)),
    box('mdia',
      fullbox('mdhd', 0, 0, zeros(8), u32(timescale), u32(0), u16(0x55c4), u16(0)),
      fullbox('hdlr', 0, 0, zeros(4), str4(handler), zeros(12), Buffer.from(isVideo ? 'Lumen video\0' : 'Lumen audio\0')),
      box('minf',
        isVideo ? fullbox('vmhd', 0, 1, zeros(8)) : fullbox('smhd', 0, 0, zeros(4)),
        box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1))),
        box('stbl', fullbox('stsd', 0, 0, u32(1), entry), fullbox('stts', 0, 0, u32(0)), fullbox('stsc', 0, 0, u32(0)),
          fullbox('stsz', 0, 0, u32(0), u32(0)), fullbox('stco', 0, 0, u32(0))))));
}

/**
 * The init segment. video: { codec, width, height, config: avcC|hvcC }; audio (optional):
 * { sampleRate, channels, config: AudioSpecificConfig, bitrate }.
 */
export function initSegment({ video, audio = null }) {
  const brand = video.codec.startsWith('avc') ? 'avc1' : 'hvc1';
  const traks = [trak({ id: VIDEO_TRACK, handler: 'vide', timescale: VIDEO_TIMESCALE, width: video.width, height: video.height, entry: visualEntry(video) })];
  const trex = [fullbox('trex', 0, 0, u32(VIDEO_TRACK), u32(1), u32(0), u32(0), u32(0))];
  if (audio) {
    traks.push(trak({ id: AUDIO_TRACK, handler: 'soun', timescale: audio.sampleRate, entry: audioEntry(audio) }));
    trex.push(fullbox('trex', 0, 0, u32(AUDIO_TRACK), u32(1), u32(0), u32(0), u32(0)));
  }
  return Buffer.concat([
    box('ftyp', str4('isom'), u32(0x200), str4('isom'), str4('iso6'), str4(brand), str4('mp41')),
    box('moov',
      fullbox('mvhd', 0, 0, zeros(8), u32(1000), u32(0), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(audio ? 3 : 2)),
      ...traks,
      box('mvex', ...trex)),
  ]);
}

/** The MIME type for MediaSource.addSourceBuffer. */
export function mimeType(videoCodec, audio = true) {
  return `video/mp4; codecs="${videoCodec}${audio ? ',mp4a.40.2' : ''}"`;
}

// ---------- media fragments ----------

const SYNC = 0x02000000; // sample_depends_on = 2 (I), sync sample
const NON_SYNC = 0x01010000; // sample_depends_on = 1, sample_is_non_sync_sample

/**
 * One moof + mdat holding a run of samples per track: tracks = [{ track, time (first sample, track
 * timescale), samples: [{ duration, data, key }] }]. The mdat holds the tracks' data in that order.
 * Fewer, larger fragments cost the TV's player far less than one per frame.
 */
export function fragmentBatch({ seq, tracks }) {
  const runs = tracks.filter((t) => t.samples.length);
  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400; // data offset, duration, size, flags
  const build = (offsets) => box('moof',
    fullbox('mfhd', 0, 0, u32(seq)),
    ...runs.map((t, i) => box('traf',
      fullbox('tfhd', 0, 0x020000, u32(t.track)), // default-base-is-moof
      fullbox('tfdt', 1, 0, u64(t.time)),
      fullbox('trun', 0, trunFlags, u32(t.samples.length), u32(offsets[i]),
        ...t.samples.flatMap((s) => [u32(s.duration), u32(s.data.length), u32(s.key ? SYNC : NON_SYNC)])))));
  const moofSize = build(runs.map(() => 0)).length;
  const offsets = [];
  let at = moofSize + 8;
  for (const t of runs) { offsets.push(at); at += t.samples.reduce((n, s) => n + s.data.length, 0); }
  const data = runs.flatMap((t) => t.samples.map((s) => s.data));
  const dataSize = at - moofSize - 8;
  return Buffer.concat([build(offsets), u32(8 + dataSize), str4('mdat'), ...data]);
}

/**
 * Where each track's tfdt time (a u64, version 1) sits in a fragment made by fragmentBatch:
 * { [track id]: byte offset }. moof > mfhd > traf > tfhd > tfdt: the first is at byte 60.
 */
export function tfdtOffsets(buf) {
  const out = {};
  const moof = listBoxes(buf).find((b) => b.type === 'moof');
  if (!moof) return out;
  for (const traf of listBoxes(buf, moof.start + 8, moof.start + moof.size)) {
    if (traf.type !== 'traf') continue;
    const inner = listBoxes(buf, traf.start + 8, traf.start + traf.size);
    const tfhd = inner.find((b) => b.type === 'tfhd');
    const tfdt = inner.find((b) => b.type === 'tfdt');
    if (tfhd && tfdt && buf[tfdt.start + 8] === 1) out[buf.readUInt32BE(tfhd.start + 12)] = tfdt.start + 12;
  }
  return out;
}

/**
 * A raw AAC-LC frame of silence (1024 samples) for 1 or 2 channels, or null for other layouts.
 * Used to fill a short seam in the audio when a viewer's timeline is rebased.
 */
export function silentAacFrame(channels) {
  if (channels === 1) return Buffer.from([0x00, 0xc8, 0x00, 0x80, 0x23, 0x80]);
  if (channels === 2) return Buffer.from([0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80]);
  return null;
}

/** One moof + mdat holding one sample of `track` at `time` (track timescale), lasting `duration`. */
export function fragment({ seq, track, time, duration, data, key = true }) {
  return fragmentBatch({ seq, tracks: [{ track, time, samples: [{ duration, data, key }] }] });
}

// ---------- reading (tests and diagnostics) ----------

/** Top-level boxes of a buffer → [{ type, start, size }]. */
export function listBoxes(buf, start = 0, end = buf.length) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    const size = buf.readUInt32BE(i);
    if (size < 8 || i + size > end) break;
    out.push({ type: buf.toString('latin1', i + 4, i + 8), start: i, size });
    i += size;
  }
  return out;
}

/** The first box of `type` found by walking the container path ('moov/trak/mdia'), or null. */
export function findBox(buf, pathSpec, start = 0, end = buf.length) {
  const [head, ...rest] = pathSpec.split('/');
  const hit = listBoxes(buf, start, end).find((b) => b.type === head);
  if (!hit) return null;
  if (!rest.length) return hit;
  return findBox(buf, rest.join('/'), hit.start + 8, hit.start + hit.size);
}

// Apps verified as installed on this Q95T (docs/research/2026-10-21-research-report.md §13–15).
// REST accepts store (numeric) ids and 10-character-package Tizen ids, never org.tizen.* / com.samsung.* aliases.
// color = the brand's primary colour; short = a 1–3 character tile glyph; dial = the DIAL app name, where known.
// The Lumen Agent (lumenrmt01.LumenAgent) is deliberately absent.

export const APPS = [
  { id: 'pvcinehd01.CineHDTV', name: 'CineHD TV', color: '#D4A24C', short: 'HD' },
  { id: '3201907018807', name: 'Netflix', color: '#E50914', short: 'N', dial: 'Netflix' },
  { id: '111299001912', name: 'YouTube', color: '#FF0000', short: '▶', dial: 'YouTube' },
  { id: '3201910019365', name: 'Prime Video', color: '#00A8E1', short: 'P', dial: 'AmazonInstantVideo' },
  { id: 'fiZNCxMH9Y.Hotstar', name: 'JioHotstar', color: '#1F80E0', short: 'JH' },
  { id: 'EUKHUxrGQA.SonyLIV', name: 'SonyLIV', color: '#E8A33D', short: 'LIV' },
  { id: 'dY5YOOBTrj.airtelxstream', name: 'Airtel Xstream', color: '#E40000', short: 'X' },
  { id: '0KIXYIdUgJ.FanCode', name: 'FanCode', color: '#F26522', short: 'FC' },
  { id: '3201807016597', name: 'Apple TV', color: '#000000', short: 'tv' },
  { id: '3201908019041', name: 'Apple Music', color: '#FA243C', short: '♪' },
  { id: '3201606009684', name: 'Spotify', color: '#1DB954', short: 'S' },
  { id: '3201512006963', name: 'Plex', color: '#E5A00D', short: '›' },
  { id: '3201907018784', name: 'Internet', color: '#6F4FF2', short: 'www' },
  { id: '3201910019378', name: 'SmartThings', color: '#15BFFF', short: 'ST' },
  { id: '3201710015037', name: 'Gallery', color: '#F2416B', short: 'G' },
  { id: '3202004020626', name: 'Amazon Alexa', color: '#00CAFF', short: 'A' },
];

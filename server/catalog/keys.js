// Remote-control keys Lumen may send over the TV's remote channel (docs/research/area-ws-remote.md §3).
// hold: 'repeat' = the server repeats clicks while held; 'press' = a real TV long-press (Press … Release);
// 'none' = click only (never held).

const key = (k, label, group, hold = 'none', icon) => ({ key: k, label, group, hold, ...(icon ? { icon } : {}) });

export const KEYS = [
  key('KEY_POWER', 'Power', 'power', 'none', 'power'),

  key('KEY_UP', 'Up', 'nav', 'repeat', 'up'),
  key('KEY_DOWN', 'Down', 'nav', 'repeat', 'down'),
  key('KEY_LEFT', 'Left', 'nav', 'repeat', 'left'),
  key('KEY_RIGHT', 'Right', 'nav', 'repeat', 'right'),
  key('KEY_ENTER', 'OK', 'nav', 'press', 'ok'),
  key('KEY_RETURN', 'Back', 'nav', 'press', 'back'),
  key('KEY_EXIT', 'Exit', 'nav', 'press', 'exit'),
  key('KEY_HOME', 'Home', 'nav', 'press', 'home'),

  key('KEY_MENU', 'TV Menu', 'menu', 'none', 'menu'),
  key('KEY_SOURCE', 'Source', 'menu', 'none', 'source'),
  key('KEY_INFO', 'Info', 'menu', 'none', 'info'),
  key('KEY_GUIDE', 'Guide', 'menu', 'none', 'guide'),
  key('KEY_CH_LIST', 'Channel List', 'menu', 'none', 'list'),
  key('KEY_TOOLS', 'Tools', 'menu', 'none', 'tools'),
  key('KEY_MORE', 'More', 'menu', 'none', 'more'),

  key('KEY_VOLUP', 'Volume Up', 'volume', 'repeat', 'vol-up'),
  key('KEY_VOLDOWN', 'Volume Down', 'volume', 'repeat', 'vol-down'),
  key('KEY_MUTE', 'Mute', 'volume', 'press', 'mute'),

  key('KEY_CHUP', 'Channel Up', 'channel', 'repeat', 'ch-up'),
  key('KEY_CHDOWN', 'Channel Down', 'channel', 'repeat', 'ch-down'),
  key('KEY_PRECH', 'Previous Channel', 'channel', 'none', 'prev-ch'),
  key('KEY_FAVCH', 'Favourites', 'channel', 'none', 'star'),

  ...'1234567890'.split('').map((d) => key(`KEY_${d}`, d, 'numbers')),
  key('KEY_MINUS', '–', 'numbers', 'none', 'dash'),

  key('KEY_RED', 'Red', 'colors', 'none', 'dot-red'),
  key('KEY_GREEN', 'Green', 'colors', 'none', 'dot-green'),
  key('KEY_YELLOW', 'Yellow', 'colors', 'none', 'dot-yellow'),
  key('KEY_BLUE', 'Blue', 'colors', 'none', 'dot-blue'),

  key('KEY_PLAY_BACK', 'Play/Pause', 'media', 'none', 'play-pause'),
  key('KEY_PLAY', 'Play', 'media', 'none', 'play'),
  key('KEY_PAUSE', 'Pause', 'media', 'none', 'pause'),
  key('KEY_STOP', 'Stop', 'media', 'none', 'stop'),
  key('KEY_REWIND', 'Rewind', 'media', 'press', 'rewind'),
  key('KEY_FF', 'Fast Forward', 'media', 'press', 'forward'),
  key('KEY_REC', 'Record', 'media', 'none', 'record'),

  key('KEY_AMBIENT', 'Ambient', 'extra', 'none', 'ambient'),
  key('KEY_BT_VOICE', 'Voice', 'extra', 'press', 'mic'),
  key('KEY_CAPTION', 'Caption', 'extra', 'none', 'caption'),
  key('KEY_SUB_TITLE', 'Subtitles', 'extra', 'none', 'subtitles'),
  key('KEY_PICTURE_SIZE', 'Picture Size', 'extra', 'none', 'aspect'),
  key('KEY_PMODE', 'Picture Mode', 'extra', 'none', 'picture'),
  key('KEY_SOUND_MODE', 'Sound Mode', 'extra', 'none', 'sound'),
  key('KEY_MTS', 'Audio Language', 'extra', 'none', 'audio'),
  key('KEY_AD', 'Accessibility', 'extra', 'none', 'accessibility'),
  key('KEY_MULTI_VIEW', 'Multi View', 'extra', 'none', 'multiview'),
  key('KEY_ESAVING', 'Eco', 'extra', 'none', 'eco'),
  key('KEY_SLEEP', 'Sleep', 'extra', 'none', 'sleep'),
  key('KEY_TV', 'Live TV', 'extra', 'none', 'tv'),
  key('KEY_HDMI', 'HDMI', 'extra', 'none', 'hdmi'),
];

// Service-menu, panel, ARC and legacy codes that can change service settings. Never sent, even if added above by mistake.
const DANGER = [/^KEY_FACTORY$/, /^KEY_11$/, /^KEY_12$/, /^KEY_EXT\d+$/, /^KEY_PANNEL_/, /^KEY_AUTO_ARC_/,
  /^KEY_ID_(INPUT|SETUP)$/, /^KEY_DTV_SIGNAL$/, /^KEY_CONVERGENCE$/, /^KEY_3SPEED$/, /^KEY_SERVICE/];

const BY_KEY = new Map(KEYS.map((k) => [k.key, k]));

// action: 'click' | 'press' | 'hold' | 'release'. Keys whose hold policy is 'none' (KEY_POWER included) may only be clicked.
export function isAllowedKey(name, action = 'click') {
  const entry = typeof name === 'string' ? BY_KEY.get(name) : undefined;
  if (!entry || DANGER.some((re) => re.test(name))) return false;
  if (action === 'press' || action === 'hold') return entry.hold !== 'none';
  return true;
}

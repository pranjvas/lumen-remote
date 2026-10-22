// Settings catalogue: every IP Control value of spec §2 plus the tracked-only settings this
// firmware has no API for. Entry fields follow spec §9.3; the browser receives SETTINGS in hello.catalog.

const GROUP_ORDER = ['picture', 'pictureAdvanced', 'sound', 'input', 'general'];

const CLARITY_CUSTOM = { key: 'picture.clarity', value: 'Custom' };

const ipc = (method, field) => ({ method, field });

const picture = (key, label, rest) => ({ key, label, group: 'picture', ...rest });
const advanced = (key, label, rest) => ({ key, label, group: 'pictureAdvanced', ...rest });
const range = (min, max) => ({ type: 'range', range: [min, max], step: 1 });
const choice = (...options) => ({ type: 'enum', options });
const tracked = (key, label, group, menuPath, rest) => ({ key, label, group, type: 'tracked', menuPath, ...rest });

const ENTRIES = [
  // Picture
  picture('picture.mode', 'Picture Mode', {
    ...choice('Dynamic', 'Standard', 'Natural', 'Movie'),
    hint: 'Filmmaker Mode appears only with Filmmaker Mode content',
    ipc: ipc('pictureModeControl', 'pictureMode'), writable: true,
  }),
  picture('picture.backlight', 'Brightness', {
    hint: 'Panel backlight', ...range(0, 50),
    ipc: ipc('backlightControl', 'backlight'), scoped: true, writable: true,
  }),
  picture('picture.contrast', 'Contrast', { ...range(0, 50), ipc: ipc('contrastControl', 'contrast'), scoped: true, writable: true }),
  picture('picture.shadowDetail', 'Shadow Detail', { ...range(-5, 5), ipc: ipc('brightnessControl', 'brightness'), scoped: true, writable: true }),
  picture('picture.sharpness', 'Sharpness', { ...range(0, 20), ipc: ipc('sharpnessControl', 'sharpness'), scoped: true, writable: true }),
  picture('picture.color', 'Color', { ...range(0, 50), ipc: ipc('colorControl', 'color'), scoped: true, writable: true }),
  picture('picture.tint', 'Tint (G/R)', {
    ...range(-50, 50), display: 'gr',
    ipc: ipc('tintControl', 'tint'), scoped: true, writable: true,
  }),
  picture('picture.colorTone', 'Color Tone', {
    ...choice('Cool', 'Standard', 'Warm1', 'Warm2'),
    ipc: ipc('colorToneControl', 'colorTone'), scoped: true, writable: true,
  }),
  picture('picture.size', 'Picture Size', { ...choice('16:9', '4:3'), ipc: ipc('pictureSizeControl', 'pictureSize'), writable: true }),

  // Picture › Advanced (Expert Settings)
  advanced('picture.localDimming', 'Local Dimming', {
    ...choice('Low', 'Standard', 'High'),
    ipc: ipc('localDimmingControl', 'localDimming'), scoped: true, writable: true,
  }),
  advanced('picture.contrastEnhancer', 'Contrast Enhancer', {
    ...choice('Off', 'Low', 'High'),
    ipc: ipc('contrastEnhancerControl', 'contrastEnhancer'), scoped: true, writable: true,
  }),
  advanced('picture.clarity', 'Picture Clarity', {
    ...choice('Off', 'Auto', 'Custom'),
    ipc: ipc('autoMotionPlusControl', 'autoMotionPlus'), scoped: true, writable: true,
  }),
  advanced('picture.blurReduction', 'Blur Reduction', {
    ...range(0, 10), dependsOn: CLARITY_CUSTOM,
    ipc: ipc('AMP.blurReductionControl', 'AMP.blurReduction'), scoped: true, writable: true,
  }),
  advanced('picture.judderReduction', 'Judder Reduction', {
    ...range(0, 10), dependsOn: CLARITY_CUSTOM,
    ipc: ipc('AMP.judderReductionControl', 'AMP.judderReduction'), scoped: true, writable: true,
  }),
  advanced('picture.ledClearMotion', 'LED Clear Motion', {
    ...choice('Off', 'On'),
    ipc: ipc('AMP.LEDClearMotionControl', 'AMP.LEDClearMotion'), scoped: true, writable: true,
  }),
  advanced('picture.noiseReduction', 'Noise Reduction', {
    ...choice('Off', 'Auto'),
    ipc: ipc('digitalCleanViewControl', 'digitalCleanView'), scoped: true, writable: true,
  }),
  advanced('picture.filmMode', 'Film Mode', { ...choice('Off', 'Auto'), ipc: ipc('filmModeControl', 'filmMode'), scoped: true, writable: true }),
  advanced('picture.gammaMode', 'Gamma', {
    type: 'readonly', options: ['BT.1886', 'ST.2084', 'HLG', '2.20'],
    ipc: ipc('gammaModeControl', 'gammaMode'), scoped: true, writable: false,
  }),
  advanced('picture.gamma', 'Gamma Level', {
    type: 'readonly', range: [-3, 3], step: 1, hint: 'BT.1886 adjustment',
    dependsOn: { key: 'picture.gammaMode', value: 'BT.1886' },
    ipc: ipc('gamma.BT1886Control', 'gamma.BT1886'), scoped: true, writable: false,
  }),
  advanced('picture.colorSpace', 'Color Space', {
    type: 'readonly', options: ['Auto', 'Native', 'Custom'],
    ipc: ipc('colorSpaceControl', 'colorSpace'), scoped: true, writable: false,
  }),
  advanced('picture.whiteBalance', 'White Balance', {
    type: 'readonly', range: [-50, 50], hint: '2 Point gain and offset (R, G, B)',
    ipc: ipc('WB2PointControl', null), scoped: true, writable: false,
  }),

  // Sound
  { key: 'audio.soundMode', label: 'Sound Mode', group: 'sound', ...choice('Standard', 'Optimized', 'Amplify'),
    ipc: ipc('soundModeControl', 'soundMode'), writable: true },
  { key: 'audio.speaker', label: 'Sound Output', group: 'sound', ...choice('Internal', 'External'),
    hint: 'TV speaker or audio out / optical', ipc: ipc('speakerSelectControl', 'speakerSelect'), writable: true },

  // Input & Source
  { key: 'input.source', label: 'Source', group: 'input', ...choice('TV', 'HDMI1', 'HDMI2', 'HDMI3', 'HDMI4', 'AV1'),
    ipc: ipc('inputSourceControl', 'inputSource'), writable: true },

  // Tracked-only: no API on this firmware; the user calibrates them and Lumen remembers.
  tracked('general.gameMode', 'Game Mode', 'general', 'Settings > General > External Device Manager > Game Mode Settings',
    { options: ['Off', 'Auto', 'On'], hint: 'Auto can switch by itself on HDMI sources' }),
  tracked('general.ambientLight', 'Ambient Light Detection', 'general', 'Settings > General > Eco Solution > Ambient Light Detection',
    { options: ['Off', 'On'], hint: 'Changes brightness by itself when on' }),
  tracked('general.powerSaving', 'Power Saving Mode', 'general', 'Settings > General > Eco Solution > Power Saving Mode',
    { options: ['Off', 'Low', 'Medium', 'High'] }),
  tracked('general.motionLighting', 'Motion Lighting', 'general', 'Settings > General > Eco Solution > Motion Lighting',
    { options: ['Off', 'On'] }),
  tracked('general.autoPowerOff', 'Auto Power Off', 'general', 'Settings > General > Eco Solution > Auto Power Off',
    { options: ['Off', '4h', '6h', '8h'] }),
  tracked('general.adaptivePicture', 'Adaptive Picture', 'general', 'Settings > General > Intelligent Mode Settings > Adaptive Picture',
    { options: ['Off', 'On'], hint: 'Adjusts brightness by itself when on' }),
  tracked('general.adaptiveSound', 'Adaptive Sound+', 'general', 'Settings > General > Intelligent Mode Settings > Adaptive Sound+',
    { options: ['Off', 'On'], hint: 'TV speaker only' }),
  tracked('sound.autoVolume', 'Auto Volume', 'sound', 'Settings > Sound > Expert Settings > Auto Volume',
    { options: ['Off', 'Normal', 'Night'] }),
  tracked('sound.balance', 'Balance', 'sound', 'Settings > Sound > Expert Settings > Balance',
    { range: [-50, 50], step: 1, hint: 'Left −50 to Right +50' }),
  tracked('picture.hdrToneMapping', 'HDR Tone Mapping', 'pictureAdvanced', 'Settings > Picture > Expert Settings > HDR Tone Mapping',
    { options: ['Off', 'Active', 'Static'], hint: 'HDR content only' }),
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SETTINGS = deepFreeze(ENTRIES);

const BY_KEY = new Map(SETTINGS.map((entry) => [entry.key, entry]));

export function getSetting(key) {
  return BY_KEY.get(key);
}

export function settingsByGroup() {
  const groups = Object.fromEntries(GROUP_ORDER.map((group) => [group, []]));
  for (const entry of SETTINGS) groups[entry.group].push(entry);
  return groups;
}

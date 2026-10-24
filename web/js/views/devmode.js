// "Enable developer mode" (Settings → Connection): the TV agent and Lumen Eyes need the TV's
// Developer mode with this PC as Host PC IP. The button hands the job to Ask Lumen, which runs the
// built-in developer-mode TV skill (server/ai/skills/developer-mode.md) through the
// enable_developer_mode tool: no TV agent or screen needed. No DOM here, so the tests can import it.

// What the owner's chat shows; the system prompt routes developer mode to enable_developer_mode.
export const DEV_MODE_PROMPT = 'Enable developer mode on the TV with this PC as the host. When it is done, tell me plainly how to restart the TV.';

export const RESTART_STEP = 'Then restart the TV: hold Power on the TV remote for about 2 seconds until it turns off, then turn it on again.';

export const CONFIRM_TEXT = [
  'Enable developer mode on the TV?',
  '',
  'Lumen takes over the TV for about a minute: it opens Apps, enters 1 2 3 4 5, switches Developer mode On and enters this PC as the Host PC IP. Whatever is on screen goes to the background. Don\'t press the TV remote meanwhile; Lumen may ask you whether a "Developer mode" box is showing.',
  '',
  'Afterwards you restart the TV: hold Power on the TV remote for about 2 seconds until it turns off, then turn it on again.',
].join('\n');

const isOn = (v) => v === true || v === '1' || v === 1;
const isOff = (v) => v === false || v === '0' || v === 0;

/**
 * What the Settings row shows, from device.developerMode / device.developerHost (REST) and the
 * links Lumen needs to run the skill. → { dot, text, action (button label or null), blocked (why
 * the button is disabled, or null) }
 */
export function devModeStatus(value, { tv, remote, ai } = {}) {
  const mode = value('device.developerMode');
  const host = value('device.developerHost');
  let out;
  if (isOn(mode) && host === 'this-pc') out = { dot: 'good', text: 'On · this PC is the host', action: null };
  else if (isOn(mode) && host === 'other') out = { dot: 'warn', text: 'On · another PC is the host', action: 'Point at this PC' };
  else if (isOn(mode)) out = { dot: 'warn', text: host === 'none' ? 'On · no host set' : 'On', action: 'Enable developer mode' };
  else if (isOff(mode)) out = { dot: 'off', text: 'Off', action: 'Enable developer mode' };
  else out = { dot: 'warn', text: 'Unknown', action: 'Enable developer mode' };
  let blocked = null;
  if (tv !== 'on') blocked = 'Turn the TV on first';
  else if (remote !== 'paired') blocked = 'Pair the remote channel first';
  else if (!ai?.ready) blocked = 'Ask Lumen needs setting up first';
  return { ...out, blocked: out.action ? blocked : null };
}

/**
 * The button's job: confirm, then start an Ask Lumen run with DEV_MODE_PROMPT (the Ask view shows
 * its progress). confirmFn is window.confirm in the page. → true when the run was started.
 */
export function startDeveloperMode(ctx, confirmFn) {
  if (!confirmFn(CONFIRM_TEXT)) return false;
  ctx.ask.submit(DEV_MODE_PROMPT);
  return true;
}

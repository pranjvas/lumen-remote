// Incognito (Browser view → hub browser.incognito): Lumen's browser on a throwaway profile, with Lumen
// keeping no record of its pages. features/browser.js runs Edge on a fresh profile in the temp folder
// and deletes it when the session ends (turned off, Edge closed or crashed, Lumen stopped, or at the
// next start after Lumen was killed). This adds the rest of Lumen:
// - while it is on, every log line goes through incognitoLine: no page address, site, title, Ask
//   Lumen request or reply is written (not even the host), in lumen.log or on the console (stdout.log);
// - the page state stays in memory only (browser.* keys are never cached to disk, and Ask Lumen does
//   not save the exchanges made meanwhile), so the TV screen, video hand-off and live video still work;
// - when it ends, the TV screen closes and what the TV screen, the relay, the converter and Ask Lumen
//   remember of the session is dropped.
import { LumenError } from '../errors.js';
import { incognitoLine } from './history.js';

export function createIncognito({ log: rootLog, store, features }) {
  const log = rootLog.child('incognito');
  const browser = () => features.browser;
  const isOn = () => browser()?.incognito?.() === true;

  // The session's pages and videos, wherever the rest of Lumen still holds them.
  async function forgetSession() {
    if (store.get('tvscreen.on')?.v === true) await features.tvscreen?.close?.().catch((err) => log.warn('the TV screen did not close', { message: err.message }));
    features.tvscreen?.forgetHistory?.();
    const streams = features.relay?.forget?.() ?? 0;
    const conversions = features.transcode?.clearSaved?.() ?? 0;
    const exchanges = features.ai?.forgetPrivate?.() ?? 0;
    log.info('incognito session forgotten', { streams, conversions, exchanges });
  }

  // Subscribed at once (not in start()): the browser's start can already report a session a killed
  // Lumen left behind.
  const unsubscribe = browser()?.onIncognito?.((on) => {
    if (!on) forgetSession().catch((err) => log.warn('incognito clean-up failed', err));
  });

  /** Incognito on or off. Turning it off closes the TV screen first: its page belongs to the session. */
  async function set({ on }) {
    const feature = browser();
    if (!feature?.setIncognito) throw new LumenError('UNAVAILABLE', 'Lumen’s browser is not available');
    if (!on && isOn() && store.get('tvscreen.on')?.v === true) await features.tvscreen?.close?.();
    return feature.setIncognito(on === true);
  }

  return {
    set,
    start() {
      // Never removed: it passes lines through untouched unless incognito is on, also while the
      // browser closes after this feature stopped.
      rootLog.setFilter?.((line) => (isOn() ? incognitoLine(line) : line));
    },
    stop() {
      unsubscribe?.(); // the converter and the relay clear themselves when Lumen stops
    },
    setDemand() {},
  };
}

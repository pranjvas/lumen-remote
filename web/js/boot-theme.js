// Applies a saved theme choice before first paint (a classic script, so CSP allows it without inline code).
(function () {
  try {
    var theme = localStorage.getItem('lumen.theme');
    if (theme === 'gallery' || theme === 'nocturne') document.documentElement.setAttribute('data-theme', theme);
  } catch (err) {
    /* storage unavailable: follow the system preference */
  }
})();

// Opened from the iPhone Home Screen, iOS sizes the page short by the height of its see-through
// status bar, and that much black shows under the tab bar. A window as wide as the screen in that
// mode is the whole screen, so the app takes the screen's height (--app-h) instead.
(function () {
  function standalone() {
    return window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }
  function fit() {
    var portrait = window.innerHeight >= window.innerWidth;
    var fullH = portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width);
    var fullW = portrait ? Math.min(screen.height, screen.width) : Math.max(screen.height, screen.width);
    var gap = fullH - window.innerHeight;
    var short = standalone() && Math.abs(window.innerWidth - fullW) < 2 && gap > 0 && gap <= 100;
    if (short) document.documentElement.style.setProperty('--app-h', fullH + 'px');
    else document.documentElement.style.removeProperty('--app-h');
  }
  // iOS settles the window's size after the first paint without always firing resize, so the check
  // runs again as the page loads, comes back and settles.
  fit();
  window.addEventListener('resize', fit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
  window.addEventListener('orientationchange', function () { setTimeout(fit, 250); });
  document.addEventListener('DOMContentLoaded', fit);
  window.addEventListener('load', fit);
  window.addEventListener('pageshow', fit);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(fit, 100); });
  [100, 400, 1000, 2500].forEach(function (ms) { setTimeout(fit, ms); });
  window.lumenFitHeight = fit;
})();

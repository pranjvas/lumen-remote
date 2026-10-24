// Applies a saved theme choice before first paint (a classic script, so CSP allows it without inline code).
(function () {
  try {
    var theme = localStorage.getItem('lumen.theme');
    if (theme === 'gallery' || theme === 'nocturne') document.documentElement.setAttribute('data-theme', theme);
  } catch (err) {
    /* storage unavailable: follow the system preference */
  }
})();


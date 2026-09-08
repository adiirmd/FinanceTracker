// Loaded synchronously in <head> so the theme is applied before first paint.
// It lives in its own file rather than an inline <script> so the Content
// Security Policy can forbid inline scripts entirely.
(function () {
  try {
    var saved = localStorage.getItem("theme");
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();

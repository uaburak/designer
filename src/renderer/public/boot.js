// The theme as the app keeps it (ThemeContext: "designer-theme" — system, light or dark), on the page before anything paints.
(function () {
  var pref = "system";
  try { pref = localStorage.getItem("designer-theme") || "system"; } catch (e) { /* the system's */ }
  var dark = pref === "dark" || (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.backgroundColor = dark ? "#2c2c2c" : "#ffffff";
})();

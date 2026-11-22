// Applies the saved colour theme (light or dark; nothing saved means "follow the
// system") and handles the theme switch. Loaded in <head> to avoid a flash.

const STORAGE_KEY = "theme";
const NEXT = { auto: "light", light: "dark", dark: "auto" };

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

try {
  applyTheme(localStorage.getItem(STORAGE_KEY));
} catch {
  // Storage blocked: follow the system theme.
}

document.addEventListener("click", (event) => {
  const toggle = event.target instanceof Element && event.target.closest("[data-theme-toggle]");
  if (!toggle) return;
  const next = NEXT[document.documentElement.dataset.theme ?? "auto"];
  applyTheme(next);
  try {
    if (next === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not saved; it still applies to this page.
  }
});

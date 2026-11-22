// Loaded on every page, in <head> (not deferred), so the saved colour theme applies
// before the first paint. Also: the theme switch, and the "4 services" lists in
// incident cards. Everything else is in app.js (public) and admin.js.

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

// "4 services" in an incident card is a <details>: a click or tap opens it. Where
// there is a mouse, hovering opens it too, and a click then keeps it open.
const canHover = matchMedia("(hover: hover)").matches;
const servicesList = (target) =>
  target instanceof Element ? target.closest("details.services-more") : null;

document.addEventListener("pointerover", (event) => {
  const list = servicesList(event.target);
  if (canHover && list) list.open = true;
});
document.addEventListener("pointerout", (event) => {
  const list = servicesList(event.target);
  if (canHover && list && !list.contains(event.relatedTarget)) list.open = false;
});
document.addEventListener("click", (event) => {
  const list = servicesList(event.target);
  // A mouse click on a list hovering has opened would close it again. (detail is 0
  // for Enter and Space, which still toggle.)
  if (list && canHover && event.detail > 0 && event.target.closest("summary")) {
    event.preventDefault();
  }
  for (const open of document.querySelectorAll("details.services-more[open]")) {
    if (open !== list) open.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const open of document.querySelectorAll("details.services-more[open]")) open.open = false;
});

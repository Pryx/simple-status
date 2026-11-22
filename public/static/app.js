// Public pages: relative times in the viewer's time zone, a 60 s refresh of the
// current status, and infinite scroll for past incidents.

const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

function relativeTime(date) {
  const seconds = (date.getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(0, "minute");
}

function localizeTimes(root) {
  for (const el of root.querySelectorAll("time[datetime]")) {
    const date = new Date(el.dateTime);
    if (Number.isNaN(date.getTime())) continue;
    el.textContent = relativeTime(date);
    el.title = absolute.format(date);
  }
}

async function fetchDocument(url) {
  // "no-cache": check with the server, which answers from its cache or with a 304.
  const res = await fetch(url, { headers: { Accept: "text/html" }, cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), "text/html");
}

// The server's markup of each live part, to tell whether a refresh changed anything.
const served = new Map(
  [...document.querySelectorAll("[data-live]")].map((el) => [el.dataset.live, el.innerHTML]),
);

localizeTimes(document);

// Refresh the status every minute: the banner's colour ([data-live-class]) and the
// [data-live] parts. A part the visitor is using (focus inside) waits for the next round.
if (document.querySelector("[data-live]")) {
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const fresh = await fetchDocument(location.href);
      for (const el of document.querySelectorAll("[data-live-class]")) {
        const match = fresh.querySelector(`[data-live-class="${el.dataset.liveClass}"]`);
        if (match) el.className = match.className;
      }
      for (const el of document.querySelectorAll("[data-live]")) {
        const match = fresh.querySelector(`[data-live="${el.dataset.live}"]`);
        if (!match || el.contains(document.activeElement)) continue;
        if (served.get(el.dataset.live) === match.innerHTML) continue; // Unchanged.
        served.set(el.dataset.live, match.innerHTML);
        localizeTimes(match);
        el.replaceChildren(...match.childNodes);
      }
    } catch {
      // Offline or unreachable: keep showing the last state.
    }
  }, 60_000);
  // Keep relative times ("5 minutes ago") current between refreshes.
  setInterval(() => localizeTimes(document), 30_000);
}

// Infinite scroll: load the next (older) month when "Load more" comes into view, or is
// clicked. Without JavaScript the link simply opens that month's page.
let loading = false;
let observer;
async function loadMore(link) {
  if (loading) return;
  loading = true;
  link.textContent = "Loading…";
  try {
    const doc = await fetchDocument(link.href);
    const list = document.querySelector(".timeline-items");
    const items = doc.querySelectorAll(".timeline-items > li");
    localizeTimes(doc.body);
    list?.append(...items);
    const next = doc.querySelector("[data-load-more]");
    if (next) link.setAttribute("href", next.getAttribute("href"));
    else link.remove();
    link.textContent = "Load more";
    if (link.isConnected) observe(link); // Again, if a failure had stopped it.
  } catch {
    // Stop loading automatically; a click retries.
    observer?.disconnect();
    observer = undefined;
    link.textContent = "Couldn't load more. Try again";
  } finally {
    loading = false;
  }
  // If the link is still in view after loading, observing again fires another load.
  if (observer && link.isConnected) {
    observer.unobserve(link);
    observer.observe(link);
  }
}

function observe(link) {
  if (observer || !("IntersectionObserver" in window)) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore(link);
    },
    { rootMargin: "400px" },
  );
  observer.observe(link);
}

const loadMoreLink = document.querySelector("[data-load-more]");
if (loadMoreLink) {
  loadMoreLink.addEventListener("click", (event) => {
    event.preventDefault();
    loadMore(loadMoreLink);
  });
  observe(loadMoreLink);
}

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
  const res = await fetch(url, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), "text/html");
}

localizeTimes(document);

// Refresh the status (banner, services, current incidents), keeping loaded history.
const live = document.querySelector("[data-live]");
if (live) {
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const fresh = (await fetchDocument(location.href)).querySelector("[data-live]");
      if (!fresh) return;
      live.replaceChildren(...fresh.childNodes);
      localizeTimes(live);
    } catch {
      // Offline or unreachable: keep showing the last state.
    }
  }, 60_000);
  // Keep relative times ("5 minutes ago") current between refreshes.
  setInterval(() => localizeTimes(document), 30_000);
}

// Infinite scroll: load the next page when "Load more" comes into view (or is clicked).
// Without JavaScript the link simply opens the next page.
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

const loadMoreLink = document.querySelector("[data-load-more]");
if (loadMoreLink) {
  loadMoreLink.addEventListener("click", (event) => {
    event.preventDefault();
    loadMore(loadMoreLink);
  });
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore(loadMoreLink);
      },
      { rootMargin: "400px" },
    );
    observer.observe(loadMoreLink);
  }
}

import { raw } from "hono/html";
import type { Child } from "hono/jsx";

export function Layout(props: {
  title: string;
  siteName: string;
  script: string;
  children: Child;
}) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>
            {props.title === props.siteName ? props.title : `${props.title} · ${props.siteName}`}
          </title>
          {/* Not deferred: applies the saved theme before the first paint. */}
          <script src="/static/theme.js" />
          <link rel="stylesheet" href="/static/style.css" />
          <script src={props.script} defer />
        </head>
        <body>{props.children}</body>
      </html>
    </>
  );
}

/** Cycles auto → light → dark. CSS shows the icon for the current choice. */
export function ThemeToggle() {
  return (
    <button
      type="button"
      class="theme-toggle"
      data-theme-toggle
      title="Switch theme (auto, light, dark)"
      aria-label="Switch theme"
    >
      <svg class="icon-auto" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" />
        <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
      </svg>
      <svg class="icon-light" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" fill="currentColor" />
        <path
          d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
      <svg class="icon-dark" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" fill="currentColor" />
      </svg>
    </button>
  );
}

/** A UTC time, shown relative and in the viewer's time zone once the script runs. */
export function Time(props: { iso: string }) {
  return <time datetime={props.iso}>{props.iso.slice(0, 16).replace("T", " ")} UTC</time>;
}

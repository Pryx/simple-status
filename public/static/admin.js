// Admin pages: submit forms as JSON to the admin API, the action buttons, inline
// editing, drag-and-drop ordering of services, and the Markdown editor.
// Inputs of type datetime-local are in the admin's local time; the API gets UTC.

const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

for (const el of document.querySelectorAll("time[datetime]")) {
  el.textContent = absolute.format(new Date(el.dateTime));
}

function toLocalInputValue(iso) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

for (const input of document.querySelectorAll("input[data-utc]")) {
  // As the default too, so an unchanged time isn't sent (and rounded to the minute).
  if (input.dataset.utc) input.defaultValue = input.value = toLocalInputValue(input.dataset.utc);
}

// Fields marked data-maintenance-only are shown (and sent) only while the impact is
// maintenance. Disabled fields are left out of the request, so the stored value stays.
for (const form of document.querySelectorAll("form")) {
  const fields = form.querySelectorAll("[data-maintenance-only]");
  if (fields.length === 0) continue;
  const sync = () => {
    const maintenance = form.querySelector("input[name=impact]:checked")?.value === "maintenance";
    for (const field of fields) {
      field.hidden = !maintenance;
      for (const input of field.querySelectorAll("input")) input.disabled = !maintenance;
    }
  };
  form.addEventListener("change", (event) => {
    if (event.target.name === "impact") sync();
  });
  sync();
}

function formToJson(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") {
      data[el.name] ??= [];
      if (el.checked) data[el.name].push(el.value);
    } else if (el.type === "radio") {
      if (el.checked) data[el.name] = el.value;
    } else if (el.type === "datetime-local") {
      // Left out when empty (a new incident starts now) or unchanged (the server keeps
      // the stored time, which has seconds the input can't show).
      if (el.value && el.value !== el.defaultValue)
        data[el.name] = new Date(el.value).toISOString();
    } else {
      data[el.name] = el.value;
    }
  }
  return data;
}

/** Sends a request to the admin API. Returns an error message, or null on success. */
async function send(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    return "The request failed. Your session may have expired: reload the page and try again.";
  }
  if (res.ok) return null;
  try {
    const problem = await res.json();
    const lines = [problem.detail ?? problem.title];
    for (const e of problem.errors ?? [])
      lines.push(e.path ? `${e.path}: ${e.message}` : e.message);
    return lines.join("\n");
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function showError(message, scope) {
  const output = scope?.querySelector(".error");
  if (output) {
    output.textContent = message;
    output.hidden = false;
  } else {
    alert(message);
  }
}

for (const form of document.querySelectorAll("form[data-api]")) {
  // Ctrl+Enter (⌘+Enter) in a text box submits, as in most comment boxes.
  form.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      event.target.matches("textarea")
    ) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    const error = await send(form.dataset.method, form.dataset.api, formToJson(form));
    button.disabled = false;
    if (error) showError(error, form);
    else location.assign(form.dataset.redirect);
  });
}

for (const button of document.querySelectorAll("button[data-action]")) {
  button.addEventListener("click", async () => {
    if (button.dataset.confirm && !confirm(button.dataset.confirm)) return;
    button.disabled = true;
    const error =
      button.dataset.action === "delete"
        ? await send("DELETE", button.dataset.api)
        : await send("POST", button.dataset.api, {});
    button.disabled = false;
    if (error) showError(error, button.closest("form"));
    else location.assign(button.dataset.redirect);
  });
}

// Inline editing: fields with data-patch are saved when they change.

const saveStatus = document.querySelector("[data-save-status]");
let statusTimer;
function announce(message, isError = false) {
  if (!saveStatus) return;
  clearTimeout(statusTimer);
  saveStatus.textContent = message;
  saveStatus.classList.toggle("error", isError);
  if (!isError) statusTimer = setTimeout(() => (saveStatus.textContent = ""), 2500);
}

for (const input of document.querySelectorAll("input[data-patch]")) {
  input.addEventListener("change", async () => {
    if (!input.reportValidity()) return;
    const error = await send("PATCH", input.dataset.patch, { [input.name]: input.value });
    if (error) {
      announce(error, true);
    } else {
      input.defaultValue = input.value;
      announce("Saved.");
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      input.value = input.defaultValue;
      input.blur();
    }
  });
}

// Drag-and-drop ordering. Uses pointer events, so it works with a mouse, touch and pen;
// the handle also responds to the arrow keys.

const sortable = document.querySelector("[data-sortable]");
if (sortable) {
  const orderOf = () => [...sortable.children].map((row) => row.dataset.id);
  let saved = orderOf().join();

  // Saves run one after another, so quick moves can't arrive out of order.
  let queue = Promise.resolve();
  const saveOrder = () => (queue = queue.then(saveCurrentOrder));

  async function saveCurrentOrder() {
    const ids = orderOf();
    if (ids.join() === saved) return;
    const error = await send("PUT", sortable.dataset.sortable, { ids });
    if (error) {
      announce(error, true);
    } else {
      saved = ids.join();
      if (!moved) announce("Order saved.");
    }
  }

  // Says where a row went, for screen readers (and as confirmation for everyone).
  let moved = false;
  function announceMove(row) {
    const rows = [...sortable.children];
    const name = row.querySelector("input[name=name]")?.value ?? "Service";
    announce(`${name} moved to position ${rows.indexOf(row) + 1} of ${rows.length}.`);
    moved = true;
    clearTimeout(announceMove.timer);
    announceMove.timer = setTimeout(() => (moved = false), 1000);
  }

  let dragged = null;

  sortable.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".drag-handle");
    if (!handle || event.button !== 0) return;
    dragged = handle.closest("li");
    dragged.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  sortable.addEventListener("pointermove", (event) => {
    if (!dragged) return;
    // Put the row before the first other row whose middle is below the pointer.
    const before = [...sortable.children].find((row) => {
      if (row === dragged) return false;
      const box = row.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    if (before !== dragged.nextElementSibling) sortable.insertBefore(dragged, before ?? null);
  });

  function drop() {
    if (!dragged) return;
    dragged.classList.remove("dragging");
    announceMove(dragged);
    dragged = null;
    saveOrder();
  }
  sortable.addEventListener("pointerup", drop);
  sortable.addEventListener("pointercancel", drop);

  sortable.addEventListener("keydown", (event) => {
    const handle = event.target.closest(".drag-handle");
    if (!handle || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const row = handle.closest("li");
    if (event.key === "ArrowUp" && row.previousElementSibling) {
      sortable.insertBefore(row, row.previousElementSibling);
    } else if (event.key === "ArrowDown" && row.nextElementSibling) {
      sortable.insertBefore(row.nextElementSibling, row);
    }
    handle.focus();
    announceMove(row);
    saveOrder();
  });
}

// Markdown editor: a small toolbar, keyboard shortcuts and a Write / Preview switch
// on textareas with data-markdown (the preview endpoint). The preview is rendered by
// the server, exactly as the public page will show it.

const TOOLS = [
  { label: "Bold", text: "B", key: "b", apply: (t) => wrap(t, "**", "**", "bold text") },
  { label: "Italic", text: "I", key: "i", apply: (t) => wrap(t, "_", "_", "italic text") },
  { label: "Link", text: "Link", key: "k", apply: (t) => link(t) },
  { label: "Code", text: "</>", apply: (t) => wrap(t, "`", "`", "code") },
  { label: "Bulleted list", text: "•", apply: (t) => prefixLines(t, () => "- ") },
  { label: "Numbered list", text: "1.", apply: (t) => prefixLines(t, (n) => `${n + 1}. `) },
];

/** Replaces the selection, keeping the browser's undo history where it can. */
function insert(textarea, text, selectFrom, selectTo) {
  const start = textarea.selectionStart;
  textarea.focus();
  if (!document.execCommand?.("insertText", false, text)) {
    textarea.setRangeText(text, start, textarea.selectionEnd, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  textarea.setSelectionRange(start + selectFrom, start + selectTo);
}

function selection(textarea) {
  return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
}

function wrap(textarea, before, after, placeholder) {
  const text = selection(textarea) || placeholder;
  insert(textarea, before + text + after, before.length, before.length + text.length);
}

function link(textarea) {
  const text = selection(textarea) || "link text";
  insert(textarea, `[${text}](https://)`, text.length + 3, text.length + 11);
}

function prefixLines(textarea, prefix) {
  // Extend the selection to whole lines.
  const value = textarea.value;
  const start = value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
  let end = value.indexOf("\n", textarea.selectionEnd);
  if (end === -1) end = value.length;
  textarea.setSelectionRange(start, end);
  const lines = value.slice(start, end).split("\n");
  const text = lines.map((line, n) => prefix(n) + line).join("\n");
  insert(textarea, text, text.length, text.length);
}

function autosize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

for (const textarea of document.querySelectorAll("textarea[data-markdown]")) {
  const toolbar = document.createElement("div");
  toolbar.className = "md-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Formatting");

  for (const tool of TOOLS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-tool";
    button.textContent = tool.text;
    button.title = tool.key ? `${tool.label} (Ctrl+${tool.key.toUpperCase()})` : tool.label;
    button.setAttribute("aria-label", tool.label);
    button.addEventListener("click", () => tool.apply(textarea));
    toolbar.append(button);
  }

  const tabs = document.createElement("span");
  tabs.className = "md-tabs";
  const write = document.createElement("button");
  const preview = document.createElement("button");
  for (const [button, text] of [
    [write, "Write"],
    [preview, "Preview"],
  ]) {
    button.type = "button";
    button.textContent = text;
    tabs.append(button);
  }
  write.setAttribute("aria-pressed", "true");
  preview.setAttribute("aria-pressed", "false");
  toolbar.append(tabs);

  const output = document.createElement("div");
  output.className = "md-preview body";
  output.hidden = true;
  output.setAttribute("aria-live", "polite");

  const editor = document.createElement("div");
  editor.className = "md-editor";
  textarea.replaceWith(editor);
  editor.append(toolbar, textarea, output);

  const showPreview = async (on) => {
    write.setAttribute("aria-pressed", String(!on));
    preview.setAttribute("aria-pressed", String(on));
    for (const button of toolbar.querySelectorAll(".md-tool")) button.disabled = on;
    textarea.hidden = on;
    output.hidden = !on;
    if (!on) {
      textarea.focus();
      return;
    }
    if (!textarea.value.trim()) {
      output.replaceChildren(
        Object.assign(document.createElement("p"), {
          className: "empty",
          textContent: "Nothing to preview.",
        }),
      );
      return;
    }
    output.textContent = "Loading preview…";
    try {
      const res = await fetch(textarea.dataset.markdown, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: textarea.value }),
        redirect: "error",
      });
      if (!res.ok) throw new Error(String(res.status));
      const { html } = await res.json();
      // Rendered by the server's Markdown renderer, which escapes HTML.
      const doc = new DOMParser().parseFromString(html, "text/html");
      output.replaceChildren(...doc.body.childNodes);
    } catch {
      output.textContent = "Couldn't load the preview.";
    }
  };
  write.addEventListener("click", () => showPreview(false));
  preview.addEventListener("click", () => showPreview(true));
  // Back to writing before submitting, so the textarea's value is what's seen.
  textarea.form?.addEventListener("submit", () => showPreview(false), { capture: true });

  textarea.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const tool = TOOLS.find((t) => t.key === event.key.toLowerCase());
    if (tool) {
      event.preventDefault();
      tool.apply(textarea);
    }
  });
  textarea.addEventListener("input", () => autosize(textarea));
  autosize(textarea);
}

// Update composer: a one-line box until it's used, like a comment box. It closes again
// when empty and you click or tab outside it, or press Escape. (Not on every focus
// change: clicking a status pill moves focus out of the textarea for a moment.)
for (const form of document.querySelectorAll("form.composer")) {
  const textarea = form.querySelector("textarea");
  const collapse = () => {
    if (!textarea.value.trim()) form.classList.add("collapsed");
  };
  form.classList.add("collapsed");
  form.addEventListener("focusin", () => {
    if (!form.classList.contains("collapsed")) return;
    form.classList.remove("collapsed");
    autosize(textarea);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!form.contains(event.target)) collapse();
  });
  form.addEventListener("focusout", (event) => {
    // Tabbing to something outside the form; a click is handled above.
    if (event.relatedTarget && !form.contains(event.relatedTarget)) collapse();
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !textarea.value.trim()) {
      document.activeElement?.blur();
      form.classList.add("collapsed");
    }
  });
}

// Publishing progress on the dashboard: checks every few seconds while pages are queued.
// The bar's fill glides to each new value (CSS transition).
const publishStatus = document.querySelector("[data-publish-status]");
if (publishStatus && !publishStatus.hidden) {
  const perMinute = Number(publishStatus.dataset.perMinute) || 25;
  const heading = publishStatus.querySelector(".publish-head strong");
  const detail = publishStatus.querySelector(".publish-head .hint");
  const bar = publishStatus.querySelector("[role=progressbar]");
  const fill = bar.querySelector("span");
  const show = (done, total) => {
    bar.setAttribute("aria-valuemax", String(Math.max(total, 1)));
    bar.setAttribute("aria-valuenow", String(done));
    fill.style.width = `${(100 * done) / Math.max(total, 1)}%`;
  };
  const describe = (queued) => {
    const minutes = Math.ceil(queued / perMinute);
    const pages = queued === 1 ? "1 page left" : `${queued} pages left`;
    return `${pages}, about ${minutes === 1 ? "a minute" : `${minutes} minutes`}`;
  };
  show(Number(bar.getAttribute("aria-valuenow")), Number(bar.getAttribute("aria-valuemax")));

  const timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch(publishStatus.dataset.publishStatus, { redirect: "error" });
      if (!res.ok) return;
      const { queued, total } = await res.json();
      if (queued === 0) {
        clearInterval(timer);
        show(1, 1);
        heading.textContent = "The public site is up to date";
        detail.textContent = "";
        publishStatus.classList.add("done");
        return;
      }
      show(total - queued, total);
      detail.textContent = describe(queued);
    } catch {
      // Try again next time.
    }
  }, 5000);
}

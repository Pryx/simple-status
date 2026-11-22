// Admin pages: submit forms as JSON to the admin API, the action buttons, inline
// editing and drag-and-drop ordering of services.
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
  if (input.dataset.utc) input.value = toLocalInputValue(input.dataset.utc);
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
      // Empty: null if the field may be cleared, otherwise left out (the server keeps
      // the current value, or uses "now" for a new incident).
      if (el.value) data[el.name] = new Date(el.value).toISOString();
      else if ("nullable" in el.dataset) data[el.name] = null;
    } else if (el.type === "number") {
      data[el.name] = el.value === "" ? null : Number(el.value);
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
    const error =
      button.dataset.action === "delete"
        ? await send("DELETE", button.dataset.api)
        : await send("PATCH", button.dataset.api, { ends_at: new Date().toISOString() });
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
      announce("Order saved.");
    }
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
    saveOrder();
  });
}

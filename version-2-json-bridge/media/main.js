(function () {
  const vscode = acquireVsCodeApi();
  const history = document.getElementById("gc-history");
  const form = document.getElementById("gc-form");
  const input = document.getElementById("gc-input");
  const suggest = document.getElementById("gc-suggest");
  const statusbar = document.getElementById("gc-statusbar");

  let slashCommands = [];
  let suggestionIndex = -1;
  let pastInputs = [];
  let pastIdx = -1;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "className") e.className = attrs[k];
        else if (k === "html") e.innerHTML = attrs[k];
        else if (k === "data") {
          for (const dk in attrs.data) e.dataset[dk] = attrs.data[dk];
        } else if (k.startsWith("on") && typeof attrs[k] === "function") {
          e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== undefined && attrs[k] !== null) {
          e.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null) continue;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return e;
  }

  function appendNode(node) {
    history.appendChild(node);
    history.scrollTop = history.scrollHeight;
  }

  function renderUser(text) {
    appendNode(el("div", { className: "gc-msg gc-msg-user" }, "> " + text));
  }

  function renderSystem(text) {
    appendNode(el("div", { className: "gc-msg gc-msg-system" }, text));
  }

  function renderError(text) {
    appendNode(el("div", { className: "gc-msg gc-msg-error" }, text));
  }

  function linkButton(url, label) {
    return el(
      "a",
      {
        className: "gc-link",
        href: "#",
        onClick: function (e) {
          e.preventDefault();
          vscode.postMessage({ type: "openUrl", url: url });
        },
      },
      label,
    );
  }

  // ---------- result renderers per method ----------

  function renderChat(p) {
    const card = el("div", { className: "gc-msg gc-card" });
    card.appendChild(el("h4", null, "Glean Assistant"));
    const body = el("div", null);
    body.style.whiteSpace = "pre-wrap";
    body.textContent = p.text || "(no content)";
    card.appendChild(body);
    if (p.citations && p.citations.length) {
      const ul = el("ul", { className: "gc-citations" });
      for (const c of p.citations) {
        const li = el("li", null, [linkButton(c.url, c.title || c.url)]);
        ul.appendChild(li);
      }
      const wrap = el("div", null, [el("h4", null, "Citations"), ul]);
      card.appendChild(wrap);
    }
    appendNode(card);
  }

  function renderSearch(p) {
    const card = el("div", { className: "gc-msg gc-card" });
    card.appendChild(el("h4", null, "Search results"));
    if (!p.results || !p.results.length) {
      card.appendChild(el("div", null, "No results."));
      appendNode(card);
      return;
    }
    for (const r of p.results) {
      const result = el("div", { className: "gc-result" });
      const title = el("div", { className: "gc-result-title" }, [
        linkButton(r.url, r.title || "(untitled)"),
      ]);
      if (r.tracking_token) {
        const fb = el("span", { className: "gc-feedback" });
        const up = el(
          "button",
          {
            title: "Send positive feedback",
            onClick: function () {
              vscode.postMessage({
                type: "feedback",
                tracking_token: r.tracking_token,
                rating: "THUMBS_UP",
              });
            },
          },
          "+",
        );
        const down = el(
          "button",
          {
            title: "Send negative feedback",
            onClick: function () {
              vscode.postMessage({
                type: "feedback",
                tracking_token: r.tracking_token,
                rating: "THUMBS_DOWN",
              });
            },
          },
          "-",
        );
        fb.appendChild(up);
        fb.appendChild(down);
        title.appendChild(fb);
      }
      result.appendChild(title);
      const meta = el(
        "div",
        { className: "gc-result-meta" },
        (r.datasource || "") + (r.url ? "  " + r.url : ""),
      );
      result.appendChild(meta);
      if (r.snippet) {
        result.appendChild(el("div", { className: "gc-result-snippet" }, r.snippet));
      }
      card.appendChild(result);
    }
    appendNode(card);
  }

  function renderStatus(p) {
    const card = el("div", { className: "gc-msg gc-card" });
    card.appendChild(el("h4", null, "Status"));
    const tbl = el("table", { className: "gc-kv" });
    const rows = [
      ["instance", p.instance || "(unset)"],
      ["base url", p.base_url || "(unset)"],
      ["mode", p.mode],
      ["api token", p.has_api_token ? "set" : "(unset)"],
      ["indexing token", p.has_indexing_token ? "set" : "(unset)"],
      ["act-as", p.act_as || "(none)"],
      ["chat id", p.current_chat_id || "(none)"],
    ];
    for (const r of rows) {
      const tr = el("tr", null, [el("td", null, r[0]), el("td", null, String(r[1]))]);
      tbl.appendChild(tr);
    }
    card.appendChild(tbl);
    appendNode(card);
    updateStatusbar(p);
  }

  function renderHelp(p) {
    const card = el("div", { className: "gc-msg gc-card" });
    card.appendChild(el("h4", null, "Commands"));
    const tbl = el("table", { className: "gc-kv" });
    for (const item of p.items) {
      tbl.appendChild(
        el("tr", null, [el("td", null, item.cmd), el("td", null, item.summary)]),
      );
    }
    card.appendChild(tbl);
    appendNode(card);
  }

  function renderJson(method, p) {
    const card = el("div", { className: "gc-msg gc-card" });
    card.appendChild(el("h4", null, method));
    const pre = el("pre", null);
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontFamily = "var(--gc-mono)";
    pre.style.fontSize = "11px";
    pre.style.margin = "0";
    pre.textContent = JSON.stringify(p, null, 2);
    card.appendChild(pre);
    appendNode(card);
  }

  function renderResultError(method, p) {
    const card = el("div", { className: "gc-msg gc-msg-error" });
    card.textContent =
      (p && p.of ? "[" + p.of + "] " : "") + ((p && p.error) || "error");
    appendNode(card);
  }

  function dispatchResult(method, payload) {
    if (method === "chat") return renderChat(payload);
    if (method === "search") return renderSearch(payload);
    if (method === "status" || method === "login" || method === "logout" || method === "set_mode")
      return renderStatus(payload);
    if (method === "help") return renderHelp(payload);
    if (method === "error") return renderResultError("error", payload);
    return renderJson(method, payload);
  }

  // ---------- status bar ----------

  function updateStatusbar(s) {
    if (!s) {
      statusbar.textContent = "connecting...";
      return;
    }
    statusbar.innerHTML = "";
    const span = document.createElement("span");
    span.className = s.mode || "";
    span.textContent = s.mode + (s.instance ? " - " + s.instance : "");
    statusbar.appendChild(span);
  }

  // ---------- slash command picker ----------

  function showSuggestions(matches) {
    suggest.innerHTML = "";
    if (!matches.length) {
      suggest.hidden = true;
      suggestionIndex = -1;
      return;
    }
    matches.forEach(function (item, i) {
      const row = el(
        "div",
        {
          className: "gc-suggest-row" + (i === suggestionIndex ? " active" : ""),
          onClick: function () {
            input.value = item.cmd + " ";
            suggest.hidden = true;
            suggestionIndex = -1;
            input.focus();
          },
        },
        [
          el("span", { className: "gc-suggest-cmd" }, item.cmd),
          el("span", { className: "gc-suggest-summary" }, item.summary || ""),
        ],
      );
      suggest.appendChild(row);
    });
    suggest.hidden = false;
  }

  function refreshSuggestions() {
    const v = input.value;
    if (!v.startsWith("/")) {
      suggest.hidden = true;
      suggestionIndex = -1;
      return;
    }
    const head = v.split(/\s/)[0];
    const matches = slashCommands.filter(function (s) {
      return s.cmd.startsWith(head);
    });
    if (matches.length === 1 && matches[0].cmd === head) {
      suggest.hidden = true;
      suggestionIndex = -1;
      return;
    }
    showSuggestions(matches.slice(0, 16));
  }

  // ---------- input wiring ----------

  function send(line) {
    line = line.trim();
    if (!line) return;
    pastInputs.push(line);
    pastIdx = pastInputs.length;
    vscode.postMessage({ type: "send", line: line });
    input.value = "";
    suggest.hidden = true;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    send(input.value);
  });

  input.addEventListener("input", refreshSuggestions);

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
      return;
    }
    if (e.key === "Tab" && !suggest.hidden) {
      e.preventDefault();
      const rows = suggest.querySelectorAll(".gc-suggest-row");
      if (!rows.length) return;
      suggestionIndex = e.shiftKey
        ? (suggestionIndex - 1 + rows.length) % rows.length
        : (suggestionIndex + 1) % rows.length;
      rows.forEach(function (r, i) {
        r.classList.toggle("active", i === suggestionIndex);
      });
      const cmd = rows[suggestionIndex].querySelector(".gc-suggest-cmd").textContent;
      input.value = cmd + " ";
      return;
    }
    if (e.key === "Escape" && !suggest.hidden) {
      suggest.hidden = true;
      suggestionIndex = -1;
      return;
    }
    if (e.key === "ArrowUp" && (input.selectionStart || 0) === 0) {
      if (pastInputs.length === 0) return;
      e.preventDefault();
      pastIdx = Math.max(0, pastIdx - 1);
      input.value = pastInputs[pastIdx] || "";
      return;
    }
    if (e.key === "ArrowDown" && pastIdx < pastInputs.length) {
      e.preventDefault();
      pastIdx = Math.min(pastInputs.length, pastIdx + 1);
      input.value = pastInputs[pastIdx] || "";
      return;
    }
  });

  history.addEventListener("contextmenu", function (e) {
    const card = e.target.closest(".gc-card, .gc-msg-user, .gc-msg-error");
    if (!card) return;
    e.preventDefault();
    vscode.postMessage({ type: "copy", text: card.innerText });
  });

  window.addEventListener("message", function (e) {
    const m = e.data;
    switch (m.kind) {
      case "ready":
        renderSystem("Bridge ready.");
        updateStatusbar(m.status);
        break;
      case "exit":
        renderSystem("Bridge exited" + (m.code != null ? " (code " + m.code + ")" : "") + ".");
        break;
      case "log":
        renderSystem(m.text);
        break;
      case "slashCommands":
        slashCommands = m.items || [];
        break;
      case "echo":
        renderUser(m.text);
        break;
      case "result":
        dispatchResult(m.method, m.payload || {});
        break;
      case "notify":
        if (m.level === "stderr") renderError(m.text);
        else renderSystem(m.text);
        break;
      case "clear":
        history.innerHTML = "";
        break;
    }
  });

  renderSystem("Connecting to bridge...");
  vscode.postMessage({ type: "ready" });
})();

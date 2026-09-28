(function () {
  const vscode = acquireVsCodeApi();
  const history = document.getElementById("gc-history");
  const form = document.getElementById("gc-form");
  const input = document.getElementById("gc-input");
  const restartBtn = document.getElementById("gc-restart");
  const suggest = document.getElementById("gc-suggest");

  let slashCommands = [];
  let suggestionIndex = -1;
  let pendingChunks = [];
  let chunkTimer = null;
  let pastInputs = [];
  let pastIdx = -1;

  const URL_RE = /(https?:\/\/[^\s)]+)/g;

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function linkify(escaped) {
    return escaped.replace(URL_RE, function (m) {
      return '<a href="#" data-url="' + m + '">' + m + "</a>";
    });
  }

  function append(kind, text, opts) {
    if (!text) return;
    const last = history.lastElementChild;
    if (kind === "stdout" && last && last.dataset.kind === "stdout" && !(opts && opts.fresh)) {
      last.dataset.raw += text;
      last.innerHTML = linkify(escapeHtml(last.dataset.raw));
    } else {
      const div = document.createElement("div");
      div.className = "gc-msg gc-msg-" + kind;
      div.dataset.kind = kind;
      div.dataset.raw = text;
      if (kind === "user") {
        div.innerHTML = '<span class="gc-prompt">&gt;</span> ' + escapeHtml(text);
      } else if (kind === "system") {
        div.innerHTML = escapeHtml(text);
      } else {
        div.innerHTML = linkify(escapeHtml(text));
      }
      history.appendChild(div);
    }
    history.scrollTop = history.scrollHeight;
  }

  function flushChunks() {
    if (!pendingChunks.length) return;
    const merged = pendingChunks.join("");
    pendingChunks = [];
    chunkTimer = null;
    append("stdout", merged);
  }

  function queueStdout(text) {
    pendingChunks.push(text);
    if (chunkTimer) return;
    chunkTimer = setTimeout(flushChunks, 30);
  }

  function showSuggestions(matches) {
    suggest.innerHTML = "";
    if (!matches.length) {
      suggest.hidden = true;
      suggestionIndex = -1;
      return;
    }
    matches.forEach(function (cmd, i) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = cmd;
      b.addEventListener("click", function () {
        input.value = cmd + " ";
        suggest.hidden = true;
        suggestionIndex = -1;
        input.focus();
      });
      if (i === suggestionIndex) b.classList.add("active");
      suggest.appendChild(b);
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
    const matches = slashCommands.filter(function (c) {
      return c.startsWith(head);
    });
    if (matches.length === 1 && matches[0] === head) {
      suggest.hidden = true;
      suggestionIndex = -1;
      return;
    }
    showSuggestions(matches.slice(0, 24));
  }

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

  restartBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "restart" });
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
      const buttons = suggest.querySelectorAll("button");
      if (!buttons.length) return;
      suggestionIndex = e.shiftKey
        ? (suggestionIndex - 1 + buttons.length) % buttons.length
        : (suggestionIndex + 1) % buttons.length;
      buttons.forEach(function (b, i) {
        b.classList.toggle("active", i === suggestionIndex);
      });
      input.value = buttons[suggestionIndex].textContent + " ";
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

  history.addEventListener("click", function (e) {
    const a = e.target.closest("a[data-url]");
    if (a) {
      e.preventDefault();
      vscode.postMessage({ type: "openUrl", url: a.dataset.url });
    }
  });

  history.addEventListener("contextmenu", function (e) {
    const msg = e.target.closest(".gc-msg");
    if (!msg) return;
    e.preventDefault();
    vscode.postMessage({ type: "copy", text: msg.dataset.raw || msg.textContent });
  });

  window.addEventListener("message", function (e) {
    const m = e.data;
    switch (m.kind) {
      case "slashCommands":
        slashCommands = m.items || [];
        break;
      case "echo":
        flushChunks();
        append("user", m.text || "", { fresh: true });
        break;
      case "stdout":
        queueStdout(m.text || "");
        break;
      case "stderr":
        flushChunks();
        append("stderr", m.text || "", { fresh: true });
        break;
      case "spawned":
        flushChunks();
        append("system", "REPL ready. Type a command or message.", { fresh: true });
        break;
      case "exit":
        flushChunks();
        append(
          "system",
          "REPL exited" + (m.code !== null ? " (code " + m.code + ")" : "") + ". Click Restart to reconnect.",
          { fresh: true },
        );
        break;
      case "restarted":
        flushChunks();
        append("system", "Restarting REPL...", { fresh: true });
        break;
    }
  });

  append("system", "Connecting to glean-code REPL...", { fresh: true });
  vscode.postMessage({ type: "ready" });
})();

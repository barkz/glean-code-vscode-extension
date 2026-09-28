/**
 * Slash-command surface, as a pure function.
 *
 * Kept free of any vscode imports so it can run in three places: the extension
 * host, the session recorder in tools/record.mjs, and unit tests. Parsing a
 * line never performs I/O — it returns a description of what should happen.
 */

export interface SlashSpec {
  cmd: string;
  summary: string;
  example?: string;
}

export const SLASH_COMMANDS: SlashSpec[] = [
  { cmd: "/help", summary: "Show available commands" },
  { cmd: "/status", summary: "Show connection state and mode" },
  { cmd: "/login", summary: "Login: /login --instance <host> --token <tok>" },
  { cmd: "/logout", summary: "Clear stored credentials" },
  { cmd: "/mode", summary: "Set mode: /mode <live|mock|auto>" },
  { cmd: "/chat", summary: "Chat with Glean: /chat <message>" },
  { cmd: "/search", summary: "Search the index: /search <query>", example: "/search quarterly planning" },
  { cmd: "/autocomplete", summary: "Autocomplete suggestions" },
  { cmd: "/datasources.list", summary: "List visible datasources" },
  { cmd: "/datasources.status", summary: "Datasource status: /datasources.status <name>" },
  { cmd: "/insights", summary: "Insights summary" },
  { cmd: "/agents.list", summary: "List agents" },
  { cmd: "/agents.run", summary: "Run an agent: /agents.run <agent-id> <input>" },
  { cmd: "/tools.list", summary: "List tools" },
  { cmd: "/tools.call", summary: "Call a tool: /tools.call <name> <json-args>" },
  { cmd: "/docs.get", summary: "Fetch documents: /docs.get --id <id>" },
  { cmd: "/people.get", summary: "Get a person: /people.get <email>" },
  { cmd: "/announcements.list", summary: "List announcements" },
  { cmd: "/collections.list", summary: "List collections" },
  { cmd: "/pins.list", summary: "List pinned results" },
  { cmd: "/clear", summary: "Clear the chat" },
];

/** Split a argument string into positionals and `--flag value` pairs. */
export function tokenize(line: string): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const out = { positional: [] as string[], flags: {} as Record<string, string | true> };
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) tokens.push(m[1] ?? m[2] ?? m[3]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out.positional.push(t);
    }
  }
  return out;
}

/** What a parsed line asks the host to do. */
export type ParsedCommand =
  /** Send `method` to the Python bridge with `params`. */
  | { kind: "call"; method: string; params: Record<string, unknown> }
  /** Render something the host already knows; no bridge round trip. */
  | { kind: "local"; method: "help"; payload: { items: SlashSpec[] } }
  /** Wipe the transcript. */
  | { kind: "clear" }
  /** Usage error — show it without contacting the bridge. */
  | { kind: "error"; error: string };

/**
 * Parse one line of user input. Bare text (no leading slash) is a chat message.
 * Unknown slash commands are an error rather than a silent no-op.
 */
export function parseLine(line: string): ParsedCommand | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("/")) {
    return { kind: "call", method: "chat", params: { message: trimmed } };
  }

  const head = trimmed.split(/\s+/)[0];
  const argText = trimmed.slice(head.length).trim();
  const { positional, flags } = tokenize(argText);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  switch (head) {
    case "/help":
      return { kind: "local", method: "help", payload: { items: SLASH_COMMANDS } };
    case "/clear":
      return { kind: "clear" };
    case "/status":
      return { kind: "call", method: "status", params: {} };
    case "/login":
      if (!flags.instance || !flags.token) {
        return { kind: "error", error: "Usage: /login --instance <host> --token <token>" };
      }
      return {
        kind: "call",
        method: "login",
        params: {
          instance: String(flags.instance),
          token: String(flags.token),
          act_as: str(flags["act-as"]),
        },
      };
    case "/logout":
      return { kind: "call", method: "logout", params: {} };
    case "/mode":
      if (!positional[0]) return { kind: "error", error: "Usage: /mode <live|mock|auto>" };
      return { kind: "call", method: "set_mode", params: { mode: positional[0] } };
    case "/chat":
      if (!argText) return { kind: "error", error: "Usage: /chat <message>" };
      return {
        kind: "call",
        method: "chat",
        params: {
          message: argText,
          new: Boolean(flags.new),
          chat_id: str(flags["chat-id"]),
          agent: str(flags.agent),
        },
      };
    case "/search": {
      if (positional.length === 0) return { kind: "error", error: "Usage: /search <query>" };
      const size = flags["page-size"] ? Number(flags["page-size"]) : undefined;
      if (size !== undefined && !Number.isFinite(size)) {
        return { kind: "error", error: `--page-size must be a number, got "${flags["page-size"]}"` };
      }
      return {
        kind: "call",
        method: "search",
        params: { query: positional.join(" "), page_size: size, datasource: str(flags.datasource) },
      };
    }
    case "/autocomplete":
      if (positional.length === 0) return { kind: "error", error: "Usage: /autocomplete <query>" };
      return { kind: "call", method: "autocomplete", params: { query: positional.join(" ") } };
    case "/datasources.list":
      return { kind: "call", method: "datasources.list", params: {} };
    case "/datasources.status":
      if (!positional[0]) return { kind: "error", error: "Usage: /datasources.status <name>" };
      return { kind: "call", method: "datasources.status", params: { datasource: positional[0] } };
    case "/insights":
      return {
        kind: "call",
        method: "insights",
        params: {
          overview: true,
          assistant: Boolean(flags.assistant) || Boolean(flags.all),
          agents: Boolean(flags.agents) || Boolean(flags.all),
        },
      };
    case "/agents.list":
      return { kind: "call", method: "agents.list", params: { query: str(flags.query) } };
    case "/agents.run":
      if (positional.length < 2) {
        return { kind: "error", error: "Usage: /agents.run <agent-id> <input>" };
      }
      return {
        kind: "call",
        method: "agents.run",
        params: { agent_id: positional[0], input: positional.slice(1).join(" ") },
      };
    case "/tools.list":
      return { kind: "call", method: "tools.list", params: {} };
    case "/tools.call": {
      if (positional.length < 2) {
        return { kind: "error", error: "Usage: /tools.call <name> <json-args>" };
      }
      let args: unknown;
      try {
        args = JSON.parse(positional.slice(1).join(" "));
      } catch (e) {
        return { kind: "error", error: `invalid JSON args: ${(e as Error).message}` };
      }
      return { kind: "call", method: "tools.call", params: { name: positional[0], arguments: args } };
    }
    case "/docs.get": {
      const ids = str(flags.id);
      const urls = str(flags.url);
      if (!ids && !urls) {
        return { kind: "error", error: "Usage: /docs.get --id <id> | --url <url>" };
      }
      return {
        kind: "call",
        method: "docs.get",
        params: { ids: ids ? [ids] : undefined, urls: urls ? [urls] : undefined },
      };
    }
    case "/people.get":
      if (!positional[0]) return { kind: "error", error: "Usage: /people.get <email>" };
      return { kind: "call", method: "people.get", params: { email: positional[0] } };
    case "/announcements.list":
      return { kind: "call", method: "announcements.list", params: {} };
    case "/collections.list":
      return { kind: "call", method: "collections.list", params: {} };
    case "/pins.list":
      return { kind: "call", method: "pins.list", params: {} };
    default:
      return { kind: "error", error: `Unknown command: ${head}. Try /help.` };
  }
}

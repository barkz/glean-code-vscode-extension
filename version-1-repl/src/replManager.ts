import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import * as os from "node:os";

/**
 * ANSI escape stripper. The CLI emits SGR sequences, OSC titles, and a
 * couple of cursor-movement codes for the status bar. We strip them all
 * before forwarding text to the webview.
 */
const ANSI_REGEX = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, "");
}

export interface ReplEvents {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exit: (code: number | null) => void;
  spawned: () => void;
}

export declare interface ReplManager {
  on<K extends keyof ReplEvents>(event: K, listener: ReplEvents[K]): this;
  emit<K extends keyof ReplEvents>(event: K, ...args: Parameters<ReplEvents[K]>): boolean;
}

/**
 * Spawns `python3 -m glean_code` and exposes a write-line / on-output API.
 *
 * The CLI runs in interactive mode when stdin is a TTY and in non-interactive
 * mode when it is a pipe. We use a pipe (so the subprocess is killable and we
 * can pump bytes), which means the CLI will read every line we write, dispatch
 * it, and print the output. We don't get the prompt or the live status bar
 * in that mode, so the webview renders its own prompt UI.
 */
export class ReplManager extends EventEmitter implements vscode.Disposable {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private outputChannel: vscode.OutputChannel;
  private starting = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    super();
    this.outputChannel = vscode.window.createOutputChannel("Glean Code (REPL)");
    this.context.subscriptions.push(this.outputChannel);
  }

  isAlive(): boolean {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null;
  }

  /**
   * Usable as an import root if it is a directory holding the glean_code
   * package, or a zipapp file — `python3 install.py` builds one, and Python
   * imports straight out of a zip that is on sys.path.
   */
  private isImportRoot(p: string): boolean {
    if (!p) return false;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return fs.existsSync(path.join(p, "glean_code", "__init__.py"));
      const fd = fs.openSync(p, "r");
      try {
        const head = Buffer.alloc(2);
        fs.readSync(fd, head, 0, 2, 0);
        if (head.toString("latin1") === "PK") return true;
        if (head.toString("latin1") === "#!") return fs.readFileSync(p).includes("glean_code/");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* unreadable — not a candidate */
    }
    return false;
  }

  /** True if the interpreter can already `import glean_code` unaided. */
  private importsCleanly(python: string): boolean {
    try {
      return spawnSync(python, ["-c", "import glean_code"], { timeout: 10000, stdio: "ignore" })
        .status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Work out what (if anything) belongs on PYTHONPATH. Returns null for
   * pythonPath when the interpreter already resolves glean_code on its own.
   *
   * Mirrors PythonBridge.resolveSourceRoot() in version-2-json-bridge; keep
   * the two in step.
   */
  private resolveSourceRoot(python: string):
    | { pythonPath: string | null; label: string }
    | { error: string } {
    const cfg = vscode.workspace.getConfiguration("gleanCode");
    const tried: string[] = [];

    const explicit = (cfg.get<string>("cliPath") || "").trim();
    if (explicit) {
      if (this.isImportRoot(explicit)) {
        return { pythonPath: explicit, label: `gleanCode.cliPath (${explicit})` };
      }
      return {
        error:
          `gleanCode.cliPath is set to "${explicit}", but that is neither a directory ` +
          `containing glean_code/ nor a glean zipapp. Fix or clear the setting.`,
      };
    }

    const fromEnv = (process.env.GLEAN_CODE_HOME || "").trim();
    if (fromEnv && this.isImportRoot(fromEnv)) {
      return { pythonPath: fromEnv, label: `GLEAN_CODE_HOME (${fromEnv})` };
    }
    if (fromEnv) tried.push(`GLEAN_CODE_HOME=${fromEnv}`);

    if (this.importsCleanly(python)) {
      return { pythonPath: null, label: `${python} already imports glean_code` };
    }
    tried.push(`${python} -c "import glean_code"`);

    const zipapps = [
      path.join(os.homedir(), ".local", "bin", "glean"),
      ...(process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((d) => path.join(d, "glean")),
    ];
    for (const z of zipapps) {
      if (this.isImportRoot(z)) return { pythonPath: z, label: `installed zipapp (${z})` };
    }
    tried.push("installed `glean` zipapp on PATH or in ~/.local/bin");

    const roots: string[] = [];
    for (const f of vscode.workspace.workspaceFolders || []) {
      const p = f.uri.fsPath;
      roots.push(p, path.resolve(p, ".."), path.resolve(p, "..", ".."));
    }
    roots.push(
      path.resolve(this.context.extensionPath, ".."),
      path.resolve(this.context.extensionPath, "..", ".."),
      path.resolve(this.context.extensionPath, "..", "..", ".."),
    );
    const seen = new Set<string>();
    for (const r of roots) {
      for (const cand of [r, path.join(r, "glean-code-cli")]) {
        if (seen.has(cand)) continue;
        seen.add(cand);
        if (this.isImportRoot(cand)) return { pythonPath: cand, label: `discovered clone (${cand})` };
      }
    }
    tried.push("a glean-code-cli clone in or beside the workspace");

    return {
      error:
        "Could not find the glean_code package. Tried:\n  - " +
        tried.join("\n  - ") +
        "\n\nFix it with any one of:\n" +
        "  - Set gleanCode.cliPath to your glean-code-cli checkout\n" +
        "  - Run `python3 install.py` in glean-code-cli (installs the `glean` zipapp)\n" +
        "  - Open glean-code-cli as a folder in this window",
    };
  }

  start(): void {
    if (this.isAlive() || this.starting) return;
    this.starting = true;

    const cfg = vscode.workspace.getConfiguration("gleanCode");
    const python = cfg.get<string>("pythonPath") || "python3";
    const extraEnv = cfg.get<Record<string, string>>("extraEnv") || {};
    const resolved = this.resolveSourceRoot(python);

    if ("error" in resolved) {
      this.outputChannel.appendLine(resolved.error);
      vscode.window
        .showErrorMessage(resolved.error.split("\n")[0], "Show details", "Open settings")
        .then((pick) => {
          if (pick === "Show details") this.outputChannel.show(true);
          if (pick === "Open settings") {
            vscode.commands.executeCommand("workbench.action.openSettings", "gleanCode.cliPath");
          }
        });
      this.emit("stderr", resolved.error + "\n");
      this.starting = false;
      return;
    }
    this.outputChannel.appendLine(`Resolved glean_code via ${resolved.label}`);
    // Only a discovered clone gives us a sensible cwd; otherwise stay put.
    const cliPath = resolved.pythonPath;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      PYTHONUNBUFFERED: "1",
      // No tty -> CLI takes the pipe branch in cli.py, no readline, no status bar.
      TERM: "dumb",
      NO_COLOR: "1",
    };
    if (cliPath) {
      env.PYTHONPATH =
        cliPath + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : "");
    }

    // A zipapp is a file, so it is never a valid cwd.
    const cwd =
      cliPath && fs.existsSync(cliPath) && fs.statSync(cliPath).isDirectory() ? cliPath : undefined;

    this.outputChannel.appendLine(`Spawning: ${python} -m glean_code  (cwd=${cwd ?? "inherited"})`);
    const proc = spawn(python, ["-m", "glean_code"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");

    proc.stdout.on("data", (chunk: string) => {
      const text = stripAnsi(chunk);
      this.outputChannel.append(text);
      this.emit("stdout", text);
    });

    proc.stderr.on("data", (chunk: string) => {
      const text = stripAnsi(chunk);
      this.outputChannel.append(`[stderr] ${text}`);
      this.emit("stderr", text);
    });

    proc.on("exit", (code) => {
      this.outputChannel.appendLine(`\nREPL exited with code ${code}`);
      this.proc = null;
      this.emit("exit", code);
    });

    proc.on("error", (err) => {
      this.outputChannel.appendLine(`Failed to spawn REPL: ${err.message}`);
      this.emit("stderr", `Failed to spawn REPL: ${err.message}\n`);
    });

    this.proc = proc;
    this.starting = false;
    this.emit("spawned");
  }

  send(line: string): void {
    if (!this.isAlive()) {
      this.start();
    }
    if (!this.proc) return;
    if (!line.endsWith("\n")) line += "\n";
    try {
      this.proc.stdin.write(line);
    } catch (e) {
      this.emit("stderr", `write failed: ${(e as Error).message}\n`);
    }
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.proc = null;
  }

  restart(): void {
    this.stop();
    this.start();
  }

  dispose(): void {
    this.stop();
  }
}

import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import * as os from "node:os";

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface BridgeEvents {
  ready: (status: any) => void;
  log: (message: string) => void;
  exit: (code: number | null) => void;
}

export declare interface PythonBridge {
  on<K extends keyof BridgeEvents>(event: K, listener: BridgeEvents[K]): this;
  emit<K extends keyof BridgeEvents>(event: K, ...args: Parameters<BridgeEvents[K]>): boolean;
}

/**
 * Manages the python/glean_bridge.py subprocess and exposes a typed
 * request/response API. The bridge speaks newline-delimited JSON: one
 * request per line in, one response per line out.
 */
export class PythonBridge extends EventEmitter implements vscode.Disposable {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private outputChannel: vscode.OutputChannel;
  private startPromise: Promise<void> | null = null;
  private versionWarned = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    super();
    this.outputChannel = vscode.window.createOutputChannel("Glean Code (Bridge)");
    this.context.subscriptions.push(this.outputChannel);
  }

  isAlive(): boolean {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null;
  }

  /**
   * A path is usable if it is either a directory containing the glean_code
   * package, or a zipapp file (what `python3 install.py` drops in ~/.local/bin)
   * — Python can import a package straight out of a zip on sys.path.
   */
  private isImportRoot(p: string): boolean {
    if (!p) return false;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return fs.existsSync(path.join(p, "glean_code", "__init__.py"));
      // zipapp: a file whose first two bytes are a zip signature, or a shebang'd zipapp
      const fd = fs.openSync(p, "r");
      try {
        const head = Buffer.alloc(2);
        fs.readSync(fd, head, 0, 2, 0);
        if (head.toString("latin1") === "PK") return true;
        if (head.toString("latin1") === "#!") {
          const buf = fs.readFileSync(p);
          return buf.includes("glean_code/");
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* unreadable — not a candidate */
    }
    return false;
  }

  /** The glean_code version this .vsix shipped, per bundled/cli-version.json. */
  private bundledVersion(): string | null {
    try {
      const stamp = path.join(this.context.extensionPath, "bundled", "cli-version.json");
      return JSON.parse(fs.readFileSync(stamp, "utf8")).version ?? null;
    } catch {
      return null;   // not bundled (dev checkout), nothing to compare against
    }
  }

  /**
   * Compare the client the bridge actually loaded against the one we shipped.
   *
   * The bundle only refreshes when the extension is packaged, so between
   * packages it silently lags the CLI. A cliPath override can also point at a
   * different tree entirely. Either way the mismatch is worth saying out loud
   * rather than serving old behaviour quietly.
   */
  private checkClientVersion(status: any): void {
    const running = status?.client_version;
    const from = status?.client_path;
    if (!running) return;          // older bridge, nothing to check

    this.outputChannel.appendLine(`[bridge] glean_code ${running} from ${from}`);

    const shipped = this.bundledVersion();
    if (!shipped || shipped === running) return;

    const msg =
      `Glean Code is running client ${running}, but this extension bundled ${shipped}.`;
    this.outputChannel.appendLine(`[bridge] ${msg}`);

    // A cliPath override is a deliberate choice, so note it without nagging.
    const override = (vscode.workspace
      .getConfiguration("gleanCodeBridge")
      .get<string>("cliPath") || "").trim();
    if (override) {
      this.outputChannel.appendLine(
        `[bridge] expected — gleanCodeBridge.cliPath points at ${override}`,
      );
      return;
    }

    if (this.versionWarned) return;
    this.versionWarned = true;
    vscode.window
      .showWarningMessage(`${msg} Repackage the extension to refresh it.`, "Show Log")
      .then((choice) => {
        if (choice === "Show Log") this.outputChannel.show(true);
      });
  }

  /** True if the interpreter can already `import glean_code` with no help. */
  private importsCleanly(python: string): boolean {
    try {
      const r = spawnSync(python, ["-c", "import glean_code"], {
        timeout: 10000,
        stdio: "ignore",
      });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Work out what (if anything) needs to go on PYTHONPATH for the bridge to
   * import glean_code. Returns null when no path is needed because the
   * interpreter already resolves it (pip install, site-packages, venv).
   *
   * Order matters: explicit config first, then env, then the zipapp bundled
   * inside this extension, then the interpreter's own view, then an installed
   * zipapp, then the workspace, then the dev tree.
   *
   * The bundled archive sits ahead of auto-discovery on purpose: a published
   * .vsix should run the client version its JSON contract was built against,
   * not whatever happens to be on the machine. Set gleanCodeBridge.cliPath to
   * override it while developing against a working tree.
   */
  private resolveSourceRoot(python: string):
    | { pythonPath: string | null; label: string }
    | { error: string } {
    const cfg = vscode.workspace.getConfiguration("gleanCodeBridge");
    const tried: string[] = [];

    const explicit = (cfg.get<string>("cliPath") || "").trim();
    if (explicit) {
      if (this.isImportRoot(explicit)) {
        return { pythonPath: explicit, label: `gleanCodeBridge.cliPath (${explicit})` };
      }
      return {
        error:
          `gleanCodeBridge.cliPath is set to "${explicit}", but that is neither a directory ` +
          `containing glean_code/ nor a glean zipapp. Fix the setting or clear it to fall back ` +
          `to auto-discovery.`,
      };
    }

    const fromEnv = (process.env.GLEAN_CODE_HOME || "").trim();
    if (fromEnv) {
      if (this.isImportRoot(fromEnv)) {
        return { pythonPath: fromEnv, label: `GLEAN_CODE_HOME (${fromEnv})` };
      }
      tried.push(`GLEAN_CODE_HOME=${fromEnv}`);
    }

    // Shipped inside the .vsix by scripts/bundle-cli.mjs. This is the path that
    // makes the extension work with no configuration at all.
    const bundled = path.join(this.context.extensionPath, "bundled", "glean-code.pyz");
    if (this.isImportRoot(bundled)) {
      return { pythonPath: bundled, label: `bundled zipapp (${bundled})` };
    }
    tried.push("bundled/glean-code.pyz inside the extension");

    if (this.importsCleanly(python)) {
      return { pythonPath: null, label: `${python} already imports glean_code` };
    }
    tried.push(`${python} -c "import glean_code"`);

    // The CLI's own installer builds a zipapp; it is importable as a path entry.
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

    // A clone open in (or next to) the current workspace.
    const roots: string[] = [];
    for (const f of vscode.workspace.workspaceFolders || []) {
      const p = f.uri.fsPath;
      roots.push(p, path.resolve(p, ".."), path.resolve(p, "..", ".."));
    }
    // The dev tree: this repo sitting beside a glean-code-cli clone (keeps F5 working).
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
        if (this.isImportRoot(cand)) {
          return { pythonPath: cand, label: `discovered clone (${cand})` };
        }
      }
    }
    tried.push("a glean-code-cli clone in or beside the workspace");

    return {
      error:
        "Could not find the glean_code package. Tried:\n  - " +
        tried.join("\n  - ") +
        "\n\nThe extension normally ships its own copy, so this usually means a " +
        "broken package. Fix it with any one of:\n" +
        "  - Reinstall the extension (its bundled/glean-code.pyz is missing)\n" +
        "  - Set gleanCodeBridge.cliPath to your glean-code-cli checkout\n" +
        "  - Run `python3 install.py` in glean-code-cli (installs the `glean` zipapp)\n" +
        "  - Open glean-code-cli as a folder in this window",
    };
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.isAlive()) return Promise.resolve();

    this.startPromise = new Promise<void>((resolve, reject) => {
      const cfg = vscode.workspace.getConfiguration("gleanCodeBridge");
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
              vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "gleanCodeBridge.cliPath",
              );
            }
          });
        this.startPromise = null;
        reject(new Error(resolved.error));
        return;
      }
      this.outputChannel.appendLine(`Resolved glean_code via ${resolved.label}`);

      const bridgeScript = path.join(this.context.extensionPath, "python", "glean_bridge.py");
      if (!fs.existsSync(bridgeScript)) {
        const msg = `Bridge script missing: ${bridgeScript}`;
        this.startPromise = null;
        reject(new Error(msg));
        return;
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...extraEnv,
        PYTHONUNBUFFERED: "1",
      };
      if (resolved.pythonPath) {
        env.PYTHONPATH =
          resolved.pythonPath +
          (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : "");
      }

      this.outputChannel.appendLine(`Spawning: ${python} -u ${bridgeScript}`);
      const proc = spawn(python, ["-u", bridgeScript], { env, stdio: ["pipe", "pipe", "pipe"] });
      proc.stdout.setEncoding("utf-8");
      proc.stderr.setEncoding("utf-8");

      let resolvedReady = false;

      proc.stdout.on("data", (chunk: string) => {
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.event === "ready") {
              this.checkClientVersion(obj.data);
              this.emit("ready", obj.data);
              if (!resolvedReady) {
                resolvedReady = true;
                resolve();
              }
            } else if (obj.event === "log") {
              this.outputChannel.appendLine(`[bridge] ${obj.data}`);
              this.emit("log", String(obj.data));
            } else if (obj.id !== undefined) {
              const p = this.pending.get(String(obj.id));
              if (!p) continue;
              this.pending.delete(String(obj.id));
              if (p.timer) clearTimeout(p.timer);
              if (obj.error) p.reject(new Error(obj.error));
              else p.resolve(obj.result);
            }
          } catch (e) {
            this.outputChannel.appendLine(`bad JSON from bridge: ${line}`);
          }
        }
      });

      proc.stderr.on("data", (chunk: string) => {
        this.outputChannel.append(`[stderr] ${chunk}`);
      });

      proc.on("exit", (code) => {
        this.outputChannel.appendLine(`Bridge exited with code ${code}`);
        for (const [, p] of this.pending) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new Error(`bridge exited (code ${code})`));
        }
        this.pending.clear();
        this.proc = null;
        this.startPromise = null;
        this.emit("exit", code);
        if (!resolvedReady) reject(new Error(`bridge exited before ready (code ${code})`));
      });

      proc.on("error", (err) => {
        this.outputChannel.appendLine(`Failed to spawn bridge: ${err.message}`);
        this.startPromise = null;
        reject(err);
      });

      this.proc = proc;
    });
    return this.startPromise;
  }

  /**
   * Call a method on the bridge. Resolves with the JSON result,
   * or rejects with an Error containing the bridge's error string.
   */
  async call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> {
    if (!this.isAlive()) await this.start();
    if (!this.proc) throw new Error("bridge not running");

    const id = String(this.nextId++);
    const line = JSON.stringify({ id, method, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout calling ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc!.stdin.write(line);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  stop(): void {
    this.startPromise = null;
    this.buf = "";
    for (const [, pend] of this.pending) {
      if (pend.timer) clearTimeout(pend.timer);
      pend.reject(new Error("bridge stopped"));
    }
    this.pending.clear();
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
    this.start().catch((e) =>
      this.outputChannel.appendLine(`restart failed: ${(e as Error).message}`),
    );
  }

  dispose(): void {
    this.stop();
  }
}

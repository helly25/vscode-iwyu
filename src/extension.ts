// Copyright 2023 M.Boerger
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const IWYU_COMMAND_ONE = "iwyu.run.one";
const IWYU_COMMAND_ALL = "iwyu.run.all";
const IWYU_DIAGNISTIC_UNUSED_HEADER = "iwyu_unused_header";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_IFNDEF = "iwyu_include_guard_bad_ifndef";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_DEFINE = "iwyu_include_guard_bad_define";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_ENDIF = "iwyu_include_guard_bad_endif";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_IFNDEF = "iwyu_include_guard_missing_ifndef";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_ENDIF = "iwyu_include_guard_missing_endif";

const INCLUDE_RE = /^\s*#\s*include\s+(<[^>]*>|"[^"]*")/g;
const INC_GUARD_IFNDEF = /^(\s*#\s*ifndef)(?:\s+)([_a-zA-Z][_a-zA-Z0-9]*)(\s.*)?$/g;
const INC_GUARD_DEFINE = /^(\s*#\s*define)(?:\s+)([_a-zA-Z][_a-zA-Z0-9]*)(\s.*)?$/g;
const INC_GUARD_ENDIF = /^(\s*#\s*endif)(?:\s+\/\/\s+([_a-zA-Z][_a-zA-Z0-9]*)(\s.*)?)?$/g;
const PRAGMA_ONCE = /^\s*#\s*pragma\s+once(\s*(\/\/.*))?$/g;

export const TRACE = vscode.LogLevel.Trace;
export const DEBUG = vscode.LogLevel.Debug;
export const INFO = vscode.LogLevel.Info;
export const WARN = vscode.LogLevel.Warning;
export const ERROR = vscode.LogLevel.Error;

const logger: vscode.LogOutputChannel = vscode.window.createOutputChannel("IWYU", { log: true });

function log(severity: vscode.LogLevel, message: string, ...args: any[]) {
    switch (severity) {
        case vscode.LogLevel.Off: return;
        case vscode.LogLevel.Trace: return logger.trace(message, ...args);
        case vscode.LogLevel.Debug: return logger.debug(message, ...args);
        case vscode.LogLevel.Info: return logger.info(message, ...args);
        case vscode.LogLevel.Warning: return logger.warn(message, ...args);
        case vscode.LogLevel.Error: return logger.error(message, ...args);
    }
}

type IncludeInfo = {
    include: string;
    line: string;
};

class IwyuData {
    output: string = "";
    updateTime: number = Date.now();
    running: number = 0;
    includesToAdd: IncludeInfo[] = [];
    includesToRemove: IncludeInfo[] = [];
    includesList: IncludeInfo[] = [];

    update(output: string, fileName: string, enableDiagnostics: boolean) {
        this.output = output;
        this.updateTime = Date.now();
        this.includesToAdd = [];
        this.includesToRemove = [];
        this.includesList = [];
        enum Mode { unused, add, remove, list };
        let mode: Mode = Mode.unused;
        output.split("\n").forEach((line: string) => {
            if (line === fileName + " should add these lines:") {
                mode = Mode.add;
            } else if (line === fileName + " should remove these lines:") {
                mode = Mode.remove;
            } else if (line === "The full include-list for " + fileName + ":") {
                mode = Mode.list;
            } else if (line === "") {
                mode = Mode.unused;
            } else {
                if (mode === Mode.remove) {
                    if (!enableDiagnostics) {
                        return;
                    }
                    if (line.startsWith("- ")) {
                        line = line.substring(2);
                    } else {
                        return;
                    }
                }
                const include = [...line.matchAll(INCLUDE_RE)][0]?.[1] ?? "";
                if (include === "") {
                    return;
                }
                switch (mode) {
                    case Mode.add:
                        this.includesToAdd.push({ include: include, line: line });
                        break;
                    case Mode.remove:
                        this.includesToRemove.push({ include: include, line: line });
                        break;
                    case Mode.list:
                        this.includesList.push({ include: include, line: line });
                        break;
                }

            }
        });
    }
};

interface IJsonCompileCommand {
    file: string;
    command?: string;
    arguments?: string[];
    directory?: string;
};

interface IJsonCompileCommands {
    [Symbol.iterator](): IterableIterator<IJsonCompileCommand>
};

class CompileCommand {
    constructor(entry: IJsonCompileCommand, directory: string) {
        this.file = entry.file;
        this.directory = directory;
        this.arguments = entry.arguments || [];
        if (this.arguments.length) {
            this.command = this.arguments[0] || "";
            this.arguments = this.arguments.slice(1);
        } else {
            const args = parseCommandLine(entry.command || "");
            this.command = args[0] || "";
            this.arguments = args.slice(1);
        }
        this.iwyuData = new IwyuData;
    }

    file: string;
    command: string;
    arguments: string[];
    directory: string;
    iwyuData: IwyuData;
};

type CompileCommandsMap = {
    [id: string]: CompileCommand;
};

class CompileCommandsData {
    constructor(config: vscode.WorkspaceConfiguration, compileCommandsJson: [string, number], workspacefolder: string) {
        this.compileCommandsJsonPath = compileCommandsJson[0];
        this.mtimeMs = compileCommandsJson[1];
        this.compileCommands = {};
        if (this.compileCommandsJsonPath !== "") {
            log(DEBUG, "Parsing: `" + this.compileCommandsJsonPath + "`");
            try {
                const json = <IJsonCompileCommands>JSON.parse(fs.readFileSync(this.compileCommandsJsonPath, "utf8"));
                for (const entry of json) {
                    let fname: string = entry.file;
                    const directory: string = entry.directory || workspacefolder;
                    if (!path.isAbsolute(fname)) {
                        fname = path.resolve(workspacefolder, directory, fname);
                    }
                    this.compileCommands[fname] = new CompileCommand(entry, directory);
                }
            }
            catch (err) {
                log(ERROR, "Error parsing '" + this.compileCommandsJsonPath + "': " + err);
            }
        }
        const ignoreRe: string = config.get("fix.ignore_re", "").trim();
        this.ignoreRe = ignoreRe === "" ? null : new RegExp(ignoreRe);
        const onlyRe: string = config.get("fix.only_re", "").trim();
        this.onlyRe = onlyRe === "" ? null : new RegExp(onlyRe);
        const headerRe: string = config.get("diagnostics.include_guard_files", "[.](h|hh|hpp|hxx)$").trim();
        this.headerRe = headerRe === "" ? null : new RegExp(headerRe);
    }

    compileCommandsJsonPath: string = "";
    compileCommands: CompileCommandsMap = {};
    mtimeMs: number = 0;
    ignoreRe: RegExp | null;
    onlyRe: RegExp | null;
    headerRe: RegExp | null;
};

// Parses a command line into an array.
// Splits on spaces as separators while respecting \, ", '.
export function parseCommandLine(cmd: string): string[] {
    const args: string[] = [];
    let single = false;
    let double = false;
    let start = 0;
    for (let i = 0; i < cmd.length; ++i) {
        if (single) {
            if (cmd[i] === "'") {
                single = false;
            }
            continue;
        }
        if (double) {
            if (cmd[i] === '"') {
                double = false;
            }
            continue;
        }
        switch (cmd[i]) {
            case " ":
                // Skip over multiple spaces.
                if (start < i) {
                    args.push(cmd.substring(start, i));
                }
                start = i + 1;
                continue;
            case "'":
                single = true;
                break;
            case '"':
                double = true;
                break;
            case "\\":
                i++;  // Simply skip to un-escape the next char.
                break;
        }
    }
    if (start < cmd.length) {
        args.push(cmd.substring(start, cmd.length));
    }
    return args;
}

async function until(conditionFunction: (() => boolean), intervalMs: number = 100) {
    const poll = (resolve: ((value?: undefined) => void), _reject?: (reason?: any) => void) => {
        if (conditionFunction()) {
            resolve();
        } else {
            setTimeout(() => poll(resolve), intervalMs);
        }
    };
    return new Promise(poll);
}

// Class to hold all relevant data needed in the extension.
class ConfigData {
    workspacefolder: string;
    config: vscode.WorkspaceConfiguration;
    compileCommandsData: CompileCommandsData;
    compileCommandsErrorShown: Boolean = false;
    compileCommandsErrorPath: string | null = null;

    constructor(workspacefolder: string) {
        this.workspacefolder = workspacefolder;
        this.config = vscode.workspace.getConfiguration("iwyu");
        if (this.config.has("diagnostics")) {
            // If the setting `iwyu.diagnostics` is present, then delete it everywhere as it can interfere.
            vscode.workspace.getConfiguration("iwyu").update("diagnostics", undefined, vscode.ConfigurationTarget.Global);
            vscode.workspace.getConfiguration("iwyu").update("diagnostics", undefined, vscode.ConfigurationTarget.Workspace);
            vscode.workspace.getConfiguration("iwyu").update("diagnostics", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        const compileCommandsJson = this.compileCommandsJson();

        this.compileCommandsData = this.parseCompileCommands(compileCommandsJson);
    }

    async waitUntilIwyuFinished(iwyuData: IwyuData) {
        await until(() => iwyuData.running === 0);
    }

    getCompileCommand(fname: string): CompileCommand | null {
        if (!path.isAbsolute(fname)) {
            fname = path.resolve(this.workspacefolder, fname);
        }
        if (!this.compileCommandsData.compileCommands.hasOwnProperty(fname)) {
            log(INFO, "Ignoring (not in `compile_commands.json`): " + fname);
            return null;
        }
        if (this.compileCommandsData.ignoreRe && fname.match(this.compileCommandsData.ignoreRe)) {
            log(INFO, "Ignoring (matches `iwyu.fix.ignore_re`): " + fname);
            return null;
        }
        if (this.compileCommandsData.onlyRe && !fname.match(this.compileCommandsData.onlyRe)) {
            log(INFO, "Ignoring (does not match `iwyu.fix.only_re`): " + fname);
            return null;
        }
        return this.compileCommandsData.compileCommands[fname] || null;
    }

    replaceWorkspaceVars(input: string): string {
        input = input.replace("${workspaceRoot}", this.workspacefolder);
        input = input.replace("${workspaceFolder}", this.workspacefolder);
        const uri = vscode.window.activeTextEditor?.document?.uri;
        const path = uri ? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath : "";
        input = input.replace("${fileWorkspaceFolder}", typeof path === "string" ? path : "");
        return input;
    }

    private badCompileCommandsSetting(compileCommandsJsonPath: string, err: any) {
        const error = "Bad `iwyu.compile_commands` setting";
        if (this.compileCommandsErrorPath === null || this.compileCommandsErrorPath !== compileCommandsJsonPath) {
            log(ERROR, error + " '" + compileCommandsJsonPath + "': " + err);
            this.compileCommandsErrorPath = compileCommandsJsonPath;
        }
        if (!this.compileCommandsErrorShown) {
            vscode.window.showErrorMessage(error + ". Please check your settings and ensure the `compile_commands.json` file is in the specified location.\n\n" + err);
        }
        this.compileCommandsErrorShown = true;
    }

    compileCommandsJson(): [string, number] {
        const compileCommandsJsonDefault = "auto";
        let compileCommandsJsonPath = this.config.get("compile_commands", compileCommandsJsonDefault);
        if (compileCommandsJsonPath === "") {
            this.badCompileCommandsSetting(compileCommandsJsonPath, "Disabling IWYU functionality.");
            return ["", -1];
        }
        const tests: readonly string[] = compileCommandsJsonPath === compileCommandsJsonDefault ?
            [
                "${workspaceFolder}/compile_commands.json",
                "${workspaceFolder}/build/compile_commands.json",
                "${fileWorkspaceFolder}/compile_commands.json",
                "${fileWorkspaceFolder}/build/compile_commands.json",
            ]
            : [compileCommandsJsonPath];
        let mtimeMs: number = -1;
        for (let test of tests) {
            try {
                test = this.replaceWorkspaceVars(test);
                const stats = fs.statSync(test);
                mtimeMs = stats.mtimeMs;
                compileCommandsJsonPath = test;
                break;
            }
            catch (err) {
                // Ignore, caught later.
            }
        }
        if (mtimeMs === -1) {
            this.badCompileCommandsSetting(compileCommandsJsonPath, "File not found. Disabling IWYU functionality.");
            return ["", -1];
        }
        if (this.compileCommandsData?.compileCommandsJsonPath !== compileCommandsJsonPath) {
            log(DEBUG, "Using compileCommandsJson: '" + compileCommandsJsonPath + "'.");
        }
        return [compileCommandsJsonPath, mtimeMs];
    }

    updateConfig() {
        this.config = vscode.workspace.getConfiguration("iwyu");
    }

    updateCompileCommands() {
        const [compileCommandsJsonPath, mtimeMs] = this.compileCommandsJson();
        if (compileCommandsJsonPath === "" || mtimeMs === -1) {
            return;  // Not found: Nothing to do.
        }
        if (this.compileCommandsData.compileCommandsJsonPath !== compileCommandsJsonPath
            || this.compileCommandsData.mtimeMs !== mtimeMs) {
            this.compileCommandsData = this.parseCompileCommands([compileCommandsJsonPath, mtimeMs]);
        }
    }

    getIncludeGuard(fileName: string, directory: string): string {
        const guard: string = this.config.get("diagnostics.include_guard", "");
        if (guard === "") {
            return "";
        }
        if (fileName.startsWith(directory)) {
            fileName = fileName.substring(directory.length);
        }
        if (fileName.startsWith("/") || fileName.startsWith(path.sep)) {
            fileName = fileName.substring(1);
        }
        fileName = fileName.replace(/[^_a-zA-Z0-9]/g, "_");
        return guard
            .replace("${file}", fileName)
            .replace("${FILE}", fileName.toUpperCase());
    }

    private parseCompileCommands(compileCommandsJson: [string, number]): CompileCommandsData {
        return new CompileCommandsData(this.config, compileCommandsJson, this.workspacefolder);
    }
};

class Extension {
    constructor(workspaceFolder: string, context: vscode.ExtensionContext) {
        const iwyuDiagnostics = vscode.languages.createDiagnosticCollection("iwyu");
        context.subscriptions.push(iwyuDiagnostics);
        this.configData = new ConfigData(workspaceFolder);

        this.subscribeToDocumentChanges(context, iwyuDiagnostics);

        context.subscriptions.push(
            vscode.languages.registerCodeActionsProvider('cpp', new IwyuQuickFix(this.configData), {
                providedCodeActionKinds: IwyuQuickFix.providedCodeActionKinds
            })
        );

        context.subscriptions.push(vscode.commands.registerCommand(IWYU_COMMAND_ONE, () => { this.iwyuCommandOne(); }));
        context.subscriptions.push(vscode.commands.registerCommand(IWYU_COMMAND_ALL, () => { this.iwyuCommandAll(); }));
    }

    private iwyuFix(compileCommand: CompileCommand, iwyuOutput: string) {
        const args = [this.configData.config.get("fix_includes.py", "fix_includes.py")];

        args.push("--basedir=" + compileCommand.directory);
        args.push(this.configData.config.get("fix.comments", false)
            ? "--comments"
            : "--nocomments");
        if (this.configData.config.get("fix.dry_run", false)) {
            args.push("--dry_run");
        }
        const ignore = this.configData.config.get("fix.ignore_re", "").trim();
        if (ignore !== "") {
            args.push("--ignore_re=" + ignore);
        }
        const only = this.configData.config.get("fix.only_re", "").trim();
        if (only !== "") {
            args.push("--only_re=" + only);
        }
        args.push(this.configData.config.get("fix.reorder", true)
            ? "--reorder"
            : "--noreorder");
        args.push(this.configData.config.get("fix.safe_headers", false)
            ? "--safe_headers"
            : "--nosafe_headers");
        args.push(this.configData.config.get("fix.update_comments", false)
            ? "--update_comments"
            : "--noupdate_comments");
        if (!this.configData.config.get("fix.fix_header", false)) {
            args.push(compileCommand.file);  // Restrict what to change
        }
        let cmd = args.join(" ");
        log(TRACE, "fix:\n(cat <<EOF...IWYU-output...EOF) | " + cmd);
        cmd = "(cat <<EOF\n" + iwyuOutput + "\nEOF\n) | " + cmd;
        exec(cmd, { cwd: compileCommand.directory }, (err: Error | null, stdout: string, stderr: string) => {
            if (err) {
                log(ERROR, err.message);
            }
            if (stderr !== "") {
                log(ERROR, stderr);
            }
            if (logger.logLevel <= DEBUG) {
                log(INFO, "fix_includes output:\n" + stdout);
            } else {
                log(INFO, stdout
                    .split(os.EOL)
                    .filter((element: string, _index, _array: string[]) => {
                        return element.includes("IWYU");
                    }).join(os.EOL));
            }
            log(INFO, "Done `" + compileCommand.file + "`");
        });
    }

    private iwyuRunCallback(compileCommand: CompileCommand, iwyuOutput: string, callback: (this: Extension, compileCommand: CompileCommand, iwyuOutput: string) => void) {
        const iwyuFilterOutput = this.configData.config.get("filter_iwyu_output", "").trim();
        if (iwyuFilterOutput !== "") {
            const filtered: string[] = [];
            const filterRe = new RegExp("#include.*(" + iwyuFilterOutput + ")");
            iwyuOutput.split("\n").forEach((line: string) => {
                if (!line.match(filterRe)) {
                    filtered.push(line);
                }
            });
            iwyuOutput = filtered.join("\n");
            log(TRACE, "IWYU output filtered:\n" + iwyuOutput);
        }
        const enableDiagnostics = this.configData.config.get("iwyu.diagnostics.unused_includes", true);
        compileCommand.iwyuData.update(iwyuOutput, compileCommand.file, enableDiagnostics);
        callback.call(this, compileCommand, iwyuOutput);
    }

    private iwyuRun(compileCommand: CompileCommand, callback: (this: Extension, compileCommand: CompileCommand, iwyuOutput: string) => void) {
        const file = compileCommand.file;
        log(DEBUG, "Checking `" + file + "`");

        const len = this.configData.config.get("iwyu.max_line_length", 80);
        const args = [`-Xiwyu --max_line_length=${len}`];

        args.push(this.configData.config
            .get("iwyu.keep", [])
            .map((x: string) => "-Xiwyu --keep=" + x)
            .join(" "));

        if (this.configData.config.get("iwyu.transitive_includes_only", true)) {
            args.push("-Xiwyu --transitive_includes_only");
        }
        if (this.configData.config.get("iwyu.no_fwd_decls", false)) {
            args.push("-Xiwyu --no_fwd_decls");
        }
        if (this.configData.config.get("iwyu.no_default_mappings", false)) {
            args.push("-Xiwyu --no_default_mappings");
        }

        const mapping = this.configData.config.get("iwyu.mapping_file", "").trim();
        if (mapping !== "") {
            args.push("-Xiwyu --mapping_file=" + mapping);
        }
        const params = this.configData.config.get("iwyu.additional_params", "");
        if (params !== "") {
            args.push(params);
        }
        let iwyu = this.configData.config.get("include-what-you-use", "include-what-you-use");
        iwyu += " " + args.concat(compileCommand.arguments).join(" ") + " 2>&1";

        log(TRACE, "Directory: `" + compileCommand.directory + "`");
        log(TRACE, "IWYU Command: " + iwyu);
        compileCommand.iwyuData.running++;
        try {
            exec(iwyu, { cwd: compileCommand.directory }, (err: Error | null, stdout: string, stderr: string) => {
                if (stderr) {
                    log(ERROR, "stderr:\n" + stderr);
                }
                if (err) {
                    log(ERROR, err.message + stdout);
                } else {
                    log(TRACE, "IWYU output:\n" + stdout);
                    this.iwyuRunCallback(compileCommand, stdout, callback);
                }
            });
        }
        finally {
            compileCommand.iwyuData.running = Math.max(0, compileCommand.iwyuData.running - 1);
        }
    }

    private iwyuCommandOne() {
        if (!vscode.window.activeTextEditor) {
            log(ERROR, "No editor.");
            return;
        }
        var editor: vscode.TextEditor = vscode.window.activeTextEditor;

        this.configData.updateConfig();
        this.configData.updateCompileCommands();
        const compileCommand = this.configData.getCompileCommand(editor.document.fileName);
        if (compileCommand) {
            editor.document.save();
            this.iwyuRun(compileCommand, this.iwyuFix);
        }
    }

    private iwyuCommandAll() {
        this.configData.updateConfig();
        this.configData.updateCompileCommands();
        vscode.workspace.saveAll();
        const root = path.normalize(this.configData.workspacefolder);
        log(INFO, "Fixing all project files.");
        for (const fname in this.configData.compileCommandsData.compileCommands) {
            if (!fname.startsWith(this.configData.workspacefolder)) {
                continue;
            }
            // Use `get...` to respect `iwyu.fix.ignore_re` and `iwyu.fix.only_re`.
            const compileCommand = this.configData.getCompileCommand(fname);
            if (!compileCommand) {
                continue;
            }
            // Compute normalized relative path.
            let relFile = fname;
            relFile = relFile.substring(root.length);
            if (relFile.startsWith("/") || relFile.startsWith(path.sep)) {
                relFile = relFile.substring(1);
            }
            // Compute the absolute first directory part, or just the filename.
            const paths = relFile.split(path.sep);
            const first = path.join(root, paths[0] || "");
            // Exclude it if it is a symbolic link (e.g. exclude 'external').
            try {
                if (fs.lstatSync(first).isSymbolicLink()) {
                    continue;
                }
            }
            catch (err) {
                // Ignore error.
            }
            this.iwyuRun(compileCommand, this.iwyuFix);
        }
    }

    private createDiagnostic(line: number, col: number, len: number, message: string, source: string): vscode.Diagnostic {
        const range = new vscode.Range(line, col, line, col + len);
        const diagnostic = new vscode.Diagnostic(
            range, message,
            vscode.DiagnosticSeverity.Warning);
        diagnostic.source = source;
        diagnostic.code = { value: "iwyu", target: vscode.Uri.parse("https://helly25.com/vscode-iwyu#" + source) };
        return diagnostic;
    }

    private createDiagnosticUnusedInclude(line: number, col: number, len: number): vscode.Diagnostic {
        return this.createDiagnostic(line, col, len, "Unused include (fix available)", IWYU_DIAGNISTIC_UNUSED_HEADER);
    }

    private createDiagnosticIncludeGuardBadIfndef(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
        return this.createDiagnostic(line, col, len, this.badIncludeGuard("#ifndef " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_IFNDEF);
    }

    private createDiagnosticIncludeGuardBadDefine(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
        return this.createDiagnostic(line, col, len, this.badIncludeGuard("#define " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_DEFINE);
    }

    private createDiagnosticIncludeGuardBadEndif(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
        return this.createDiagnostic(line, col, len, this.badIncludeGuard("#endif  // " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_ENDIF);
    }

    private createDiagnosticIncludeGuardMissingIfndef(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
        return this.createDiagnostic(line, col, len, this.badIncludeGuard("#ifndef " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_IFNDEF);
    }

    private createDiagnosticIncludeGuardMissingEndif(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
        return this.createDiagnostic(line, col, len, this.badIncludeGuard("#endif  // " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_ENDIF);
    }

    private badIncludeGuard(expected: string) {
        return "Missing include guard (fix available), expected: '" + expected + "'";
    }

    private addIncludeGuardRef(doc: vscode.TextDocument, diagnostic: vscode.Diagnostic, includeGuardLine: number): vscode.Diagnostic {
        const range = new vscode.Range(includeGuardLine, 0, includeGuardLine, doc.lineAt(includeGuardLine).text.length);
        const related = new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, range), "Location of include guard.");
        diagnostic.relatedInformation = [related];
        return diagnostic;
    }

    private iwyuDiagnosticsScan(compileCommand: CompileCommand, doc: vscode.TextDocument, iwyuDiagnostics: vscode.DiagnosticCollection): void {
        const diagnostics: vscode.Diagnostic[] = [];
        const includesToRemove = compileCommand.iwyuData.includesToRemove;
        const scanMin: number = this.configData.config.get("diagnostics.scan_min", 100);
        let scanMax: number = scanMin;
        const scanMore: number = this.configData.config.get("diagnostics.scan_more", 10);
        const expectedIncludeGuard: string = this.configData.getIncludeGuard(doc.fileName, compileCommand.directory);
        const headerRe = this.configData.compileCommandsData.headerRe;
        const headerMatch = headerRe !== null ? headerRe.test(doc.fileName) : false;
        const checkIncludeGuard: boolean = expectedIncludeGuard !== "" && headerMatch;
        let includeGuardLine: number = -1;
        let pragmaOnceLine: number = -1;
        let includeStart: number = -1;
        let firstLineLength = 0;
        for (let line = 0; line < scanMax && line < doc.lineCount; line++) {
            const lineOfText = doc.lineAt(line);
            if (line === 0) {
                firstLineLength = lineOfText.text.length;
            }
            if (line < scanMin) {
                if (lineOfText.isEmptyOrWhitespace) {
                    scanMax++;
                    continue;
                }
                const p = lineOfText.firstNonWhitespaceCharacterIndex;
                if (p >= 0) {
                    if (lineOfText.text.substring(p, p + 2) === "//") {
                        scanMax++;
                        continue;
                    }
                    if (lineOfText.text[p] === "#") {
                        scanMax++;
                        // no continue, must scan the line
                    }
                }
            }
            if (checkIncludeGuard) {
                if (includeGuardLine === -1) {
                    const guard = [...lineOfText.text.matchAll(INC_GUARD_IFNDEF)][0]?.[2] ?? "";
                    if (guard !== "") {
                        includeGuardLine = line;
                        if (guard !== expectedIncludeGuard) {
                            diagnostics.push(this.createDiagnosticIncludeGuardBadIfndef(
                                line, 0, lineOfText.text.length, expectedIncludeGuard));
                        }
                    }
                    const once = [...lineOfText.text.matchAll(PRAGMA_ONCE)];
                    if (once.length > 0) {
                        includeGuardLine = line;
                        pragmaOnceLine = line;
                    }
                }
                if (pragmaOnceLine === -1 && line === includeGuardLine + 1) {
                    const guard = [...lineOfText.text.matchAll(INC_GUARD_DEFINE)][0]?.[2] ?? "";
                    if (guard !== expectedIncludeGuard) {
                        // The empty string would indicate "#define" is missing or has no value.
                        diagnostics.push(this.addIncludeGuardRef(
                            doc,
                            this.createDiagnosticIncludeGuardBadDefine(line, 0, lineOfText.text.length, expectedIncludeGuard),
                            includeGuardLine));
                    }
                }
            }
            const include = [...lineOfText.text.matchAll(INCLUDE_RE)][0]?.[1] ?? "";
            if (include === "") {
                continue;
            }
            if (includeStart === -1) {
                includeStart = line;
            }
            if (includesToRemove.length) {
                if (line >= scanMin) {
                    scanMax = Math.max(line + 1 + scanMore, scanMax);
                }
                const unusedIndex = includesToRemove.findIndex((v, _i, _o) => {
                    return v.include === include;
                });
                if (unusedIndex < 0) {
                    // `findIndex` will return -1 which would be interpreted as 1 from the back.
                    continue;
                }
                const unusedInclude = includesToRemove[unusedIndex]?.include ?? "";
                if (!unusedInclude) {
                    continue;
                }
                let start = lineOfText.text.indexOf(unusedInclude);
                if (start >= 0) {
                    let len: number;
                    if (this.configData.config.get("diagnostics.full_line_squiggles", true)) {
                        start = 0;
                        len = lineOfText.text.length;
                    } else {
                        const hash = lineOfText.text.indexOf("#");
                        len = unusedInclude.length + start - hash;
                        start = hash;
                    }
                    diagnostics.push(this.createDiagnosticUnusedInclude(line, start, len));
                }
            }
        }
        if (checkIncludeGuard) {
            if (includeGuardLine === -1) {
                diagnostics.push(this.createDiagnosticIncludeGuardMissingIfndef(0, 0, firstLineLength, expectedIncludeGuard));
            } else {
                let includeGuardEndLine: number = -1;
                const lastLine: number = doc.lineCount - 1;
                for (let line = lastLine; line > 0 && line > lastLine - 10; line--) {
                    const lineOfText = doc.lineAt(line);
                    const match = [...lineOfText.text.matchAll(INC_GUARD_ENDIF)] ?? [];
                    if (match.length === 0) {
                        continue;
                    }
                    const guard = match[0]?.[2] || "";
                    includeGuardEndLine = line;
                    if (guard !== expectedIncludeGuard) {
                        diagnostics.push(
                            this.addIncludeGuardRef(
                                doc,
                                this.createDiagnosticIncludeGuardBadEndif(
                                    line, 0, lineOfText.text.length, expectedIncludeGuard),
                                includeGuardLine));
                    }
                    break;
                }
                if (includeGuardEndLine === -1) {
                    diagnostics.push(this.createDiagnosticIncludeGuardMissingEndif(
                        lastLine, 0, doc.lineAt(lastLine).text.length, expectedIncludeGuard));
                }
            }
        }
        iwyuDiagnostics.set(doc.uri, diagnostics);
    }

    private iwyuDiagnosticsRefresh(doc: vscode.TextDocument, iwyuDiagnostics: vscode.DiagnosticCollection) {
        if (doc.languageId !== "cpp") {
            return;
        }
        this.configData.updateConfig();
        let diagnosticsOnlyRe: string = this.configData.config.get("diagnostics.only_re", "");
        if (typeof diagnosticsOnlyRe  !== "string" || String(diagnosticsOnlyRe) === "true") {
            // There was a bug fixed in https://github.com/helly25/vscode-iwyu/pull/4.
            // This allows diagnostics to work in setups where defaults were copied into the user/workspace settings.
            log(ERROR, "Bad value for setting `iwyu.diagnostics.only_re`, please update to `\"\"`.");
            this.configData.config.update("diagnostics.only_re", undefined);
            diagnosticsOnlyRe = "";
        }
        if (diagnosticsOnlyRe && !doc.fileName.match(diagnosticsOnlyRe)) {
            return;
        }
        this.configData.updateCompileCommands();
        var compileCommand = this.configData.getCompileCommand(doc.fileName);
        if (!compileCommand) {
            return;
        }
        const iwyuData = compileCommand.iwyuData;
        this.configData.waitUntilIwyuFinished(iwyuData).then(() => {
            if (!compileCommand) {
                return;
            }
            if (iwyuData.output !== "" && iwyuData.updateTime + this.configData.config.get("diagnostics.iwyu_interval", 1000) > Date.now()) {
                this.iwyuDiagnosticsScan(compileCommand, doc, iwyuDiagnostics);
            } else {
                // doc.save();
                this.iwyuRun(compileCommand, (compileCommand: CompileCommand, _iwyuOutput: string) => this.iwyuDiagnosticsScan(compileCommand, doc, iwyuDiagnostics));
            }
        });
    }

    private subscribeToDocumentChanges(context: vscode.ExtensionContext, iwyuDiagnostics: vscode.DiagnosticCollection): void {
        if (vscode.window.activeTextEditor) {
            this.iwyuDiagnosticsRefresh(vscode.window.activeTextEditor.document, iwyuDiagnostics);
        }
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    this.iwyuDiagnosticsRefresh(editor.document, iwyuDiagnostics);
                }
            })
        );
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(e => this.iwyuDiagnosticsRefresh(e.document, iwyuDiagnostics))
        );
        context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(doc => iwyuDiagnostics.delete(doc.uri))
        );
    }

    private configData: ConfigData;
}

class IwyuQuickFix implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    constructor(configData: ConfigData) {
        this.configData = configData;
    }

    provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, _token: vscode.CancellationToken): vscode.CodeAction[] {
        // For each diagnostic entry that has the matching `code`, create a code action command.
        // But only if the diagnostic fully overlaps with the provided range (de-duplication).
        return context.diagnostics
            .filter(diagnostic => this.filterDiagnostics(diagnostic, range))
            .map(diagnostic => this.createCommandCodeAction(doc, diagnostic));
    }

    private filterDiagnostics(diagnostic: vscode.Diagnostic, range: vscode.Range | vscode.Selection): boolean {
        switch (diagnostic.source) {
            case IWYU_DIAGNISTIC_UNUSED_HEADER:
                return range.contains(diagnostic.range);
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_IFNDEF:
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_DEFINE:
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_ENDIF:
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_IFNDEF:
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_ENDIF:
                return true;
        }
        return false;
    }

    private createCommandCodeAction(doc: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
        switch (diagnostic.source) {
            default:  // Make compiler happy. The filter above checks that no default case happens here.
            case IWYU_DIAGNISTIC_UNUSED_HEADER: {
                const action = new vscode.CodeAction('Run IWYU to fix includes.', vscode.CodeActionKind.QuickFix);
                action.command = { command: IWYU_COMMAND_ONE, title: 'Run IWYU to fix includes', tooltip: 'Run IWYU to fix includes.' };
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                return action;
            }
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_DEFINE:
                return this.fixIncludeGuard(doc, diagnostic, INC_GUARD_DEFINE, false, "#define", " ", false);
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_ENDIF:
                return this.fixIncludeGuard(doc, diagnostic, INC_GUARD_ENDIF, false, "#endif", "  // ", false);
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_IFNDEF:
                return this.fixIncludeGuard(doc, diagnostic, INC_GUARD_IFNDEF, false, "#ifndef", " ", false);
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_ENDIF:
                return this.fixIncludeGuard(doc, diagnostic, INC_GUARD_ENDIF, true, "#endif", "  // ", false);
            case IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_IFNDEF:
                return this.fixIncludeGuard(doc, diagnostic, INC_GUARD_IFNDEF, true, "#ifndef", " ", true);
        }
    }

    private fixIncludeGuard(doc: vscode.TextDocument, diagnostic: vscode.Diagnostic, regexp: RegExp, missing: boolean, type: string, separator: string, addDefine: boolean): vscode.CodeAction {
        const action = new vscode.CodeAction('Fix include guard.', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        const line = diagnostic.range.start.line;
        const text = doc.lineAt(line).text;
        let newText = "";
        const guard = [...text.matchAll(regexp)][0];
        const cc = this.configData.getCompileCommand(doc.fileName);
        const expected = this.configData.getIncludeGuard(doc.fileName, cc?.directory || "");
        const edits: Array<vscode.TextEdit> = [];
        let eol = "\n";
        if (doc.eol === vscode.EndOfLine.CRLF) {
            eol = "\r\n";
        }
        if (addDefine) {
            const lastLine: number = doc.lineCount;
            edits.push(vscode.TextEdit.insert(new vscode.Position(lastLine, 0), eol + "#endif  // " + expected + eol));
        }
        if (guard) {
            missing = false;
            newText = guard[1] + separator + expected + (guard[3] || "");
        } else {
            newText = type + separator + expected;
        }
        if (addDefine) {
            newText += eol + "#define " + expected;
        }
        edits.push(missing ? vscode.TextEdit.insert(new vscode.Position(line, 0), newText + eol)
            : vscode.TextEdit.replace(new vscode.Range(line, 0, line, text.length), newText));
        action.edit.set(doc.uri, edits);
        return action;
    }

    private configData: ConfigData;
}

export function activate(context: vscode.ExtensionContext) {
    log(INFO, "Extension activated");
    const workspaceFolder = vscode.workspace?.workspaceFolders?.at(0)?.uri.fsPath ?? "";
    if (workspaceFolder === "") {
        log(ERROR, "No workspace folder set. Not activating IWYU.");
        return;
    }

    new Extension(workspaceFolder, context);
}

export function deactivate() { }

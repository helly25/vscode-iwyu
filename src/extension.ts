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

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const IWYU_COMMAND_ONE = "iwyu.run.one";
const IWYU_COMMAND_ALL = "iwyu.run.all";
const IWYU_DIAGNISTIC_UNUSED_HEADER = "iwyu.unused_header";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_IFNDEF = "iwyu.include_guard_bad_ifndef";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_DEFINE = "iwyu.include_guard_bad_define";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_ENDIF = "iwyu.include_guard_bad_endif";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_IFNDEF = "iwyu.include_guard_missing_ifndef";
const IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_ENDIF = "iwyu.include_guard_missing_endif";

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

let logger: vscode.LogOutputChannel = vscode.window.createOutputChannel("IWYU", { log: true });

function log(severity: vscode.LogLevel, message: string, ...args: any[]) {
    switch (severity) {
        case vscode.LogLevel.Off: return;
        case vscode.LogLevel.Trace: return logger.debug(message, ...args);
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

    update(output: string, fileName: string) {
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
                    if (line.startsWith("- ")) {
                        line = line.substring(2);
                    } else {
                        return;
                    }
                }
                let include = [...line.matchAll(INCLUDE_RE)][0]?.[1] ?? "";
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
            let args = parseCommandLine(entry.command || "");
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
    constructor(config: vscode.WorkspaceConfiguration, compileCommandsJson: string, workspacefolder: string) {
        log(DEBUG, "Parsing: `" + compileCommandsJson + "`");
        this.mtimeMs = fs.statSync(compileCommandsJson).mtimeMs;
        this.compileCommands = {};
        let json = <IJsonCompileCommands>JSON.parse(fs.readFileSync(compileCommandsJson, "utf8"));
        for (let entry of json) {
            let fname: string = entry.file;
            let directory: string = entry.directory || workspacefolder;
            if (!path.isAbsolute(fname)) {
                fname = path.resolve(workspacefolder, directory, fname);
            }
            this.compileCommands[fname] = new CompileCommand(entry, directory);
        }
        let ignoreRe: string = config.get("fix.ignore_re", "").trim();
        this.ignoreRe = ignoreRe === "" ? null : new RegExp(ignoreRe);
        let onlyRe: string = config.get("fix.only_re", "").trim();
        this.onlyRe = onlyRe === "" ? null : new RegExp(onlyRe);
        let headerRe: string = config.get("diagnostics.include_guard_files", "[.](h|hh|hpp|hxx)$").trim();
        this.headerRe = headerRe === "" ? null : new RegExp(headerRe);
    }

    compileCommands: CompileCommandsMap = {};
    mtimeMs: number = 0;
    ignoreRe: RegExp | null;
    onlyRe: RegExp | null;
    headerRe: RegExp | null;
};

// Parses a command line into an array.
// Splits on spaces as separators while respecting \, ", '.
export function parseCommandLine(cmd: string): string[] {
    let args: string[] = [];
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

    constructor(workspacefolder: string) {
        this.workspacefolder = workspacefolder;
        this.config = vscode.workspace.getConfiguration("iwyu");
        this.compileCommandsData = this.parseCompileCommands();
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

    compileCommandsJson(): string {
        return this.config
            .get("compile_commands.json", "${workspaceFolder}/compile_commands.json")
            .replace("${workspaceRoot}", this.workspacefolder)
            .replace("${workspaceFolder}", this.workspacefolder);
    }

    updateConfig() {
        this.config = vscode.workspace.getConfiguration("iwyu");
    }

    updateCompileCommands() {
        let stats = fs.statSync(this.compileCommandsJson());
        if (stats.mtimeMs !== this.compileCommandsData.mtimeMs) {
            this.compileCommandsData = this.parseCompileCommands();
        }
    }

    private parseCompileCommands(): CompileCommandsData {
        return new CompileCommandsData(this.config, this.compileCommandsJson(), this.workspacefolder);
    }
};

function iwyuFix(configData: ConfigData, compileCommand: CompileCommand, iwyuOutput: string) {
    let args = [configData.config.get("fix_includes.py", "fix_includes.py")];

    args.push("--basedir=" + compileCommand.directory);
    args.push(configData.config.get("fix.comments", false)
        ? "--comments"
        : "--nocomments");
    if (configData.config.get("fix.dry_run", false)) {
        args.push("--dry_run");
    }
    let ignore = configData.config.get("fix.ignore_re", "").trim();
    if (ignore !== "") {
        args.push("--ignore_re=" + ignore);
    }
    let only = configData.config.get("fix.only_re", "").trim();
    if (only !== "") {
        args.push("--only_re=" + only);
    }
    args.push(configData.config.get("fix.reorder", true)
        ? "--reorder"
        : "--noreorder");
    args.push(configData.config.get("fix.safe_headers", false)
        ? "--safe_headers"
        : "--nosafe_headers");
    args.push(configData.config.get("fix.update_comments", false)
        ? "--update_comments"
        : "--noupdate_comments");
    args.push(compileCommand.file);  // Restrict what to change
    let cmd = args.join(" ");
    log(TRACE, "fix:\n(cat <<EOF...IWYU-output...EOF) | " + cmd);
    cmd = "(cat <<EOF\n" + iwyuOutput + "\nEOF\n) | " + cmd;
    child_process.exec(cmd, { cwd: compileCommand.directory }, (err: Error | null, stdout: string, stderr: string) => {
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

function iwyuRunCallback(configData: ConfigData, compileCommand: CompileCommand, iwyuOutput: string, callback: ((configData: ConfigData, compileCommand: CompileCommand, iwyuOutput: string) => void)) {
    let iwyuFilterOutput = configData.config.get("filter_iwyu_output", "").trim();
    if (iwyuFilterOutput !== "") {
        let filtered: string[] = [];
        const filterRe = new RegExp("#include.*(" + iwyuFilterOutput + ")");
        iwyuOutput.split("\n").forEach((line: string) => {
            if (!line.match(filterRe)) {
                filtered.push(line);
            }
        });
        iwyuOutput = filtered.join("\n");
        log(TRACE, "IWYU output filtered:\n" + iwyuOutput);
    }
    compileCommand.iwyuData.update(iwyuOutput, compileCommand.file);
    callback(configData, compileCommand, iwyuOutput);
}

function iwyuRun(compileCommand: CompileCommand, configData: ConfigData, callback: ((configData: ConfigData, compileCommand: CompileCommand, iwyuOutput: string) => void)) {
    let file = compileCommand.file;
    log(DEBUG, "Checking `" + file + "`");

    let len = configData.config.get("iwyu.max_line_length", 80);
    let args = [`-Xiwyu --max_line_length=${len}`];

    args.push(configData.config
        .get("iwyu.keep", [])
        .map((x: string) => "-Xiwyu --keep=" + x)
        .join(" "));

    if (configData.config.get("iwyu.transitive_includes_only", true)) {
        args.push("-Xiwyu --transitive_includes_only");
    }
    if (configData.config.get("iwyu.no_fwd_decls", false)) {
        args.push("-Xiwyu --no_fwd_decls");
    }
    if (configData.config.get("iwyu.no_default_mappings", false)) {
        args.push("-Xiwyu --no_default_mappings");
    }

    let mapping = configData.config.get("iwyu.mapping_file", "").trim();
    if (mapping !== "") {
        args.push("-Xiwyu --mapping_file=" + mapping);
    }
    let params = configData.config.get("iwyu.additional_params", "");
    if (params !== "") {
        args.push(params);
    }
    let iwyu = configData.config.get("include-what-you-use", "include-what-you-use");
    iwyu += " " + args.concat(compileCommand.arguments).join(" ") + " 2>&1";

    log(TRACE, "Directory: `" + compileCommand.directory + "`");
    log(TRACE, "IWYU Command: " + iwyu);
    compileCommand.iwyuData.running++;
    try {
        child_process.exec(iwyu, { cwd: compileCommand.directory }, (err: Error | null, stdout: string, stderr: string) => {
            if (stderr) {
                log(ERROR, "stderr:\n" + stderr);
            }
            if (err) {
                log(ERROR, err.message + stdout);
            } else {
                log(TRACE, "IWYU output:\n" + stdout);
                iwyuRunCallback(configData, compileCommand, stdout, callback);
            }
        });
    }
    finally {
        compileCommand.iwyuData.running = Math.max(0, compileCommand.iwyuData.running - 1);
    }
}

function iwyuCommandOne(configData: ConfigData) {
    if (!vscode.window.activeTextEditor) {
        log(ERROR, "No editor.");
        return;
    }
    var editor: vscode.TextEditor = vscode.window.activeTextEditor;

    configData.updateConfig();
    configData.updateCompileCommands();
    let compileCommand = configData.getCompileCommand(editor.document.fileName);
    if (compileCommand) {
        editor.document.save();
        iwyuRun(compileCommand, configData, iwyuFix);
    }
}

function iwyuCommandAll(configData: ConfigData) {
    configData.updateConfig();
    configData.updateCompileCommands();
    vscode.workspace.saveAll();
    let root = path.normalize(configData.workspacefolder);
    log(INFO, "Fixing all project files.");
    for (let fname in configData.compileCommandsData.compileCommands) {
        if (!fname.startsWith(configData.workspacefolder)) {
            continue;
        }
        // Use `get...` to respect `iwyu.fix.ignore_re` and `iwyu.fix.only_re`.
        let compileCommand = configData.getCompileCommand(fname);
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
        let paths = relFile.split(path.sep);
        let first = path.join(root, paths[0] || "");
        // Exclude it if it is a symbolic link (e.g. exclude 'external').
        if (fs.lstatSync(first).isSymbolicLink()) {
            continue;
        }
        iwyuRun(compileCommand, configData, iwyuFix);
    }
}

function createDiagnostic(line: number, col: number, len: number, message: string, source: string): vscode.Diagnostic {
    const range = new vscode.Range(line, col, line, col + len);
    const diagnostic = new vscode.Diagnostic(
        range, message,
        vscode.DiagnosticSeverity.Warning);
    diagnostic.source = source;
    diagnostic.code = { value: "iwyu", target: vscode.Uri.parse("https://helly25.com/vscode-iwyu") };
    return diagnostic;
}

function createDiagnosticUnusedInclude(line: number, col: number, len: number): vscode.Diagnostic {
    return createDiagnostic(line, col, len, "Unused include (fix available)", IWYU_DIAGNISTIC_UNUSED_HEADER);
}

function createDiagnosticIncludeGuardBadIfndef(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
    return createDiagnostic(line, col, len, badIncludeGuard("#ifndef " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_IFNDEF);
}

function createDiagnosticIncludeGuardBadDefine(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
    return createDiagnostic(line, col, len, badIncludeGuard("#define " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_DEFINE);
}

function createDiagnosticIncludeGuardBadEndif(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
    return createDiagnostic(line, col, len, badIncludeGuard("#endif  // " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_BAD_ENDIF);
}

function createDiagnosticIncludeGuardMissingIfndef(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
    return createDiagnostic(line, col, len, badIncludeGuard("#ifndef " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_IFNDEF);
}

function createDiagnosticIncludeGuardMissingEndif(line: number, col: number, len: number, expectedIncludeGuard: string): vscode.Diagnostic {
    return createDiagnostic(line, col, len, badIncludeGuard("#endif  // " + expectedIncludeGuard), IWYU_DIAGNISTIC_INCLUDE_GUARD_MISSING_ENDIF);
}

function badIncludeGuard(expected: string) {
    return "Missing include guard (fix available), expected: '" + expected + "'";
}

function addIncludeGuardRef(doc: vscode.TextDocument, diagnostic: vscode.Diagnostic, includeGuardLine: number): vscode.Diagnostic {
    let range = new vscode.Range(includeGuardLine, 0, includeGuardLine, doc.lineAt(includeGuardLine).text.length);
    let related = new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, range), "Location of include guard.");
    diagnostic.relatedInformation = [related];
    return diagnostic;
}

function includeGuard(configData: ConfigData, fileName: string, directory: string): string {
    if (fileName.startsWith(directory)) {
        fileName = fileName.substring(directory.length);
    }
    if (fileName.startsWith("/") || fileName.startsWith(path.sep)) {
        fileName = fileName.substring(1);
    }
    fileName = fileName.replace(/[^_a-zA-Z0-9]/g, "_");
    return configData.config.get("diagnostic.include_guard", "${FILE}_")
        .replace("${file}", fileName)
        .replace("${FILE}", fileName.toUpperCase());
}

function iwyuDiagnosticsScan(configData: ConfigData, compileCommand: CompileCommand, doc: vscode.TextDocument, iwyuDiagnostics: vscode.DiagnosticCollection): void {
    const diagnostics: vscode.Diagnostic[] = [];
    const includesToRemove = compileCommand.iwyuData.includesToRemove;
    let scanMin: number = configData.config.get("diagnostics.scan_min", 100);
    let scanMax: number = scanMin;
    let scanMore: number = configData.config.get("diagnostics.scan_more", 10);
    let expectedIncludeGuard: string = includeGuard(configData, doc.fileName, compileCommand.directory);
    let headerRe = configData.compileCommandsData.headerRe;
    let checkIncludeGuard: boolean = headerRe !== null
        && path.extname(doc.fileName).match(headerRe) !== null
        && configData.config.get("diagnostics.include_guard", "").length > 0;
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
            let p = lineOfText.firstNonWhitespaceCharacterIndex;
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
                let guard = [...lineOfText.text.matchAll(INC_GUARD_IFNDEF)][0]?.[2] ?? "";
                if (guard !== "") {
                    includeGuardLine = line;
                    if (guard !== expectedIncludeGuard) {
                        diagnostics.push(createDiagnosticIncludeGuardBadIfndef(
                            line, 0, lineOfText.text.length, expectedIncludeGuard));
                    }
                }
                let once = [...lineOfText.text.matchAll(PRAGMA_ONCE)];
                if (once.length > 0) {
                    includeGuardLine = line;
                    pragmaOnceLine = line;
                }
            }
            if (pragmaOnceLine === -1 && line === includeGuardLine + 1) {
                let guard = [...lineOfText.text.matchAll(INC_GUARD_DEFINE)][0]?.[2] ?? "";
                if (guard !== expectedIncludeGuard) {
                    // The empty string would indicate "#define" is missing or has no value.
                    diagnostics.push(addIncludeGuardRef(
                        doc,
                        createDiagnosticIncludeGuardBadDefine(line, 0, lineOfText.text.length, expectedIncludeGuard),
                        includeGuardLine));
                }
            }
        }
        let include = [...lineOfText.text.matchAll(INCLUDE_RE)][0]?.[1] ?? "";
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
            let unusedIndex = includesToRemove.findIndex((v, _i, _o) => {
                return v.include === include;
            });
            if (unusedIndex < 0) {
                // `findIndex` will return -1 which would be interpreted as 1 from the back.
                continue;
            }
            let unusedInclude = includesToRemove[unusedIndex]?.include ?? "";
            if (!unusedInclude) {
                continue;
            }
            let start = lineOfText.text.indexOf(unusedInclude);
            if (start >= 0) {
                let len: number;
                if (configData.config.get("diagnostics.full_line_squiggles", true)) {
                    start = 0;
                    len = lineOfText.text.length;
                } else {
                    let hash = lineOfText.text.indexOf("#");
                    len = unusedInclude.length + start - hash;
                    start = hash;
                }
                diagnostics.push(createDiagnosticUnusedInclude(line, start, len));
            }
        }
    }
    if (checkIncludeGuard) {
        if (includeGuardLine === -1) {
            diagnostics.push(createDiagnosticIncludeGuardMissingIfndef(0, 0, firstLineLength, expectedIncludeGuard));
        } else {
            let includeGuardEndLine: number = -1;
            let lastLine: number = doc.lineCount - 1;
            for (let line = lastLine; line > 0 && line > lastLine - 10; line--) {
                const lineOfText = doc.lineAt(line);
                let match = [...lineOfText.text.matchAll(INC_GUARD_ENDIF)] ?? [];
                if (match.length === 0) {
                    continue;
                }
                let guard = match[0]?.[2] || "";
                includeGuardEndLine = line;
                if (guard !== expectedIncludeGuard) {
                    diagnostics.push(
                        addIncludeGuardRef(
                            doc,
                            createDiagnosticIncludeGuardBadEndif(
                                line, 0, lineOfText.text.length, expectedIncludeGuard),
                            includeGuardLine));
                }
                break;
            }
            if (includeGuardEndLine === -1) {
                diagnostics.push(createDiagnosticIncludeGuardMissingEndif(
                    lastLine, 0, doc.lineAt(lastLine).text.length, expectedIncludeGuard));
            }
        }
    }
    iwyuDiagnostics.set(doc.uri, diagnostics);
}

function iwyuDiagnosticsRefresh(configData: ConfigData, doc: vscode.TextDocument, iwyuDiagnostics: vscode.DiagnosticCollection) {
    if (doc.languageId !== "cpp") {
        return;
    }
    configData.updateConfig();
    let diagnosticsOnlyRe: string = configData.config.get("diagnostics.only_re", "");
    if (diagnosticsOnlyRe && !doc.fileName.match(diagnosticsOnlyRe)) {
        return;
    }
    configData.updateCompileCommands();
    var compileCommand = configData.getCompileCommand(doc.fileName);
    if (!compileCommand) {
        return;
    }
    let iwyuData = compileCommand.iwyuData;
    configData.waitUntilIwyuFinished(iwyuData).then(() => {
        if (!compileCommand) {
            return;
        }
        if (iwyuData.output !== "" && iwyuData.updateTime + configData.config.get("diagnostics.iwyu_interval", 1000) > Date.now()) {
            iwyuDiagnosticsScan(configData, compileCommand, doc, iwyuDiagnostics);
        } else {
            // doc.save();
            iwyuRun(compileCommand, configData, (configData: ConfigData, compileCommand: CompileCommand, _iwyuOutput: string) => iwyuDiagnosticsScan(configData, compileCommand, doc, iwyuDiagnostics));
        }
    });
}

function subscribeToDocumentChanges(configData: ConfigData, context: vscode.ExtensionContext, iwyuDiagnostics: vscode.DiagnosticCollection): void {
    if (vscode.window.activeTextEditor) {
        iwyuDiagnosticsRefresh(configData, vscode.window.activeTextEditor.document, iwyuDiagnostics);
    }
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                iwyuDiagnosticsRefresh(configData, editor.document, iwyuDiagnostics);
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => iwyuDiagnosticsRefresh(configData, e.document, iwyuDiagnostics))
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => iwyuDiagnostics.delete(doc.uri))
    );
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
        let line = diagnostic.range.start.line;
        let text = doc.lineAt(line).text;
        let newText = "";
        let guard = [...text.matchAll(regexp)][0];
        let cc = this.configData.getCompileCommand(doc.fileName);
        let expected = includeGuard(this.configData, doc.fileName, cc?.directory || "");
        let edits: Array<vscode.TextEdit> = [];
        let eol = "\n";
        if (doc.eol === vscode.EndOfLine.CRLF) {
            eol = "\r\n";
        }
        if (addDefine) {
            let lastLine: number = doc.lineCount;
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
    let workspacefolder = vscode.workspace?.workspaceFolders?.at(0)?.uri.fsPath ?? "";
    if (workspacefolder === "") {
        log(ERROR, "No workspace folder set. Not activating IWYU.");
        return;
    }
    let configData = new ConfigData(workspacefolder);

    const iwyuDiagnostics = vscode.languages.createDiagnosticCollection("iwyu");
    context.subscriptions.push(iwyuDiagnostics);

    subscribeToDocumentChanges(configData, context, iwyuDiagnostics);

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('cpp', new IwyuQuickFix(configData), {
            providedCodeActionKinds: IwyuQuickFix.providedCodeActionKinds
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand(IWYU_COMMAND_ONE, () => { iwyuCommandOne(configData); }));
    context.subscriptions.push(vscode.commands.registerCommand(IWYU_COMMAND_ALL, () => { iwyuCommandAll(configData); }));
}

export function deactivate() { }

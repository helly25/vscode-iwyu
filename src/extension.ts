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
import * as util from 'util';
import * as vscode from 'vscode';

const IWYU_COMMAND = "iwyu.run";
const IWYU_DIAGNISTIC = "iwyu";

type CompileCommand = {
    file: string;
    command: string;
    arguments: string[];
    directory: string;
};

type CompileCommandsMap = {
    [id: string]: CompileCommand;
};

type CompileCommandsData = {
    compileCommands: CompileCommandsMap;
    mtimeMs: number;
    ignoreRe: RegExp | null;
    onlyRe: RegExp | null;
};

enum LogSeverity {
    debug = 0,
    info = 1,
    warn = 2,
    error = 3,
};

const DEBUG = LogSeverity.debug;
const INFO = LogSeverity.info;
const WARN = LogSeverity.warn;
const ERROR = LogSeverity.error;

let logger = vscode.window.createOutputChannel("IWYU");

function log(severity: LogSeverity, message: string) {
    if (severity === DEBUG && !vscode.workspace.getConfiguration("iwyu").get("debug", false)) {
        return;
    }
    switch (severity) {
        case LogSeverity.debug: return logger.appendLine("DEBUG: " + message);
        case LogSeverity.info: return logger.appendLine("INFO: " + message);
        case LogSeverity.warn: return logger.appendLine("WARNING: " + message);
        case LogSeverity.error: return logger.appendLine("ERROR: " + message);
    }
}

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
        return this.compileCommandsData.compileCommands[fname];
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
        let compileCommandsJson = this.compileCommandsJson();
        log(DEBUG, "Parsing: `" + compileCommandsJson + "`");
        let mtimeMs = fs.statSync(compileCommandsJson).mtimeMs;
        let compileCommands = JSON.parse(fs.readFileSync(compileCommandsJson, "utf8"));
        let cc: CompileCommandsMap = {};
        for (let entry of compileCommands) {
            let fname: string = entry.file;
            let directory: string = this.workspacefolder;
            if (entry.hasOwnProperty("directory")) {
                directory = entry.directory;
            }
            if (!path.isAbsolute(fname)) {
                fname = path.resolve(this.workspacefolder, directory, fname);
            }
            cc[fname] = entry;
            cc[fname].directory = directory;
            if (entry.hasOwnProperty("arguments")) {
                cc[fname].command = entry.arguments[0];
                cc[fname].arguments = entry.arguments.slice(1);
            } else {
                let args = parseCommandLine(entry.command);
                cc[fname].command = args[0];
                cc[fname].arguments = args.slice(1);
            }
        }
        let ignoreRe: string = this.config.get("fix.ignore_re", "");
        let onlyRe = this.config.get("fix.only_re", "");
        return {
            compileCommands: cc,
            mtimeMs: mtimeMs,
            ignoreRe: ignoreRe === "" ? null : new RegExp(ignoreRe),
            onlyRe: onlyRe === "" ? null : new RegExp(onlyRe),
        };
    }
};

function iwyuFix(configData: ConfigData, compileCommand: CompileCommand, iwyuOutput: string) {
    let directory = compileCommand.directory;
    let args = [configData.config.get("fix_includes.py", "fix_includes.py")];
    args.push(configData.config.get("fix.comments", true)
        ? "--comments"
        : "--nocomments");
    args.push(configData.config.get("fix.safe", true)
        ? "--safe_headers"
        : "--nosafe_headers");
    args.push(configData.config.get("fix.reorder", true)
        ? "--reorder"
        : "--noreorder");
    if (configData.config.get("fix.ignore_re", "").trim() !== "") {
        args.push("--ignore_re=" + configData.config.get("ignore_re", ""));
    }
    if (configData.config.get("fix.only_re", "").trim() !== "") {
        args.push("--only_re=" + configData.config.get("only_re", ""));
    }
    let cmd = args.join(" ");
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
        log(DEBUG, "IWYU output filtered:\n" + iwyuOutput);
    }
    log(DEBUG, "fix:\n(cat <<EOF...IWYU-output...EOF) | " + cmd);
    cmd = "(cat <<EOF\n" + iwyuOutput + "\nEOF\n) | " + cmd;
    child_process.exec(cmd, { cwd: directory }, (err: Error | null, stdout: string, _stderr: string) => {
        if (err) {
            log(ERROR, err.message);
        }
        log(INFO, stdout
            .split(os.EOL)
            .filter((element: string, _index, _array: string[]) => {
                return element.includes("IWYU");
            }).join(os.EOL));
        log(INFO, "Done `" + compileCommand.file + "`");
    });
}

function iwyuRun(compileCommand: CompileCommand, configData: ConfigData, callback: ((configData: ConfigData, compileCommand: CompileCommand, iwyuOutput: string) => void)) {
    let file = compileCommand.file;
    log(DEBUG, "Checking `" + file + "`");
    let iwyu = configData.config.get("include-what-you-use", "include-what-you-use");

    // IWYU args
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

    if (configData.config.get("iwyu.mapping_file", "").trim() !== "") {
        args.push("-Xiwyu --mapping_file=" + configData.config.get("mapping_file", ""));
    }
    if (configData.config.get("iwyu.additional_params", "") !== "") {
        args.push(configData.config.get("additional_params", ""));
    }
    iwyu += " " + args.concat(compileCommand.arguments).join(" ") + " 2>&1";

    let directory = compileCommand.directory;
    log(DEBUG, "Directory: `" + directory + "`");
    log(DEBUG, "IWYU Command: " + iwyu);
    child_process.exec(iwyu, { cwd: directory }, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
            log(ERROR, err.message + stdout);
        } else {
            log(DEBUG, "IWYU output:\n" + stdout);
        }
        if (!err) {
            callback(configData, compileCommand, stdout);
        }
    });
}

function iwyuCommand(configData: ConfigData) {
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

function createDiagnostic(doc: vscode.TextDocument, lineOfText: vscode.TextLine, line: number, col: number, len: number, include: string): vscode.Diagnostic {
    // Create range for the `include`.
    const range = new vscode.Range(line, col, line, col + len);
    const diagnostic = new vscode.Diagnostic(
        range, "IWYU: Unused include: " + include,
        vscode.DiagnosticSeverity.Information);
    diagnostic.code = IWYU_DIAGNISTIC;
    return diagnostic;
}

const removeIncludeRe = /#include\s+(<[^>]*>|"[^"]*")/g;
const includeRe = /^#include\s+(<[^>]*>|"[^"]*")/g;

function getUnusedIncludes(fname: string, iwyuOutput: string): string[] {
    let result: string[] = [];
    let iwyuLines = iwyuOutput.split("\n");
    let start = fname + " should remove these lines:";
    let started = false;
    for (let i = 0; i < iwyuLines.length; i++) {
        let line = iwyuLines[i];
        if (started) {
            if (line === "") {
                break;
            }
            let matches = [...line.matchAll(removeIncludeRe)];
            if (matches.length) {
                result.push(matches[0][1]);
            }
        } else if (line === start) {
            started = true;
        }
    }
    return result;
}

function refreshDiagnostics(configData: ConfigData, doc: vscode.TextDocument, iwyuDiagnostics: vscode.DiagnosticCollection): void {
    if (doc.languageId !== "cpp") {
        return;
    }
    configData.updateCompileCommands();
    let compileCommand = configData.getCompileCommand(doc.fileName);
    if (!compileCommand) {
        return;
    }
    iwyuRun(compileCommand, configData, (configData: ConfigData, compileCommand: CompileCommand, iwyuOutput: string) => {
        const unusedIncludes = getUnusedIncludes(compileCommand.file, iwyuOutput);
        const diagnostics: vscode.Diagnostic[] = [];
        if (unusedIncludes) {
            for (let line = 0; line < doc.lineCount; line++) {
                const lineOfText = doc.lineAt(line);
                let matches = [...lineOfText.text.matchAll(includeRe)];
                if (matches.length === 0) {
                    continue;
                }
                let lineInclude = matches[0][1];
                let unusedIndex = unusedIncludes.findIndex((v, i, o) => {
                    return v === lineInclude;
                });
                if (unusedIndex >= 0) {
                    let unusedInclude = unusedIncludes[unusedIndex];
                    let start = lineOfText.text.indexOf(unusedInclude);
                    if (start >= 0) {
                        diagnostics.push(createDiagnostic(doc, lineOfText, line, 0, start + unusedInclude.length, unusedInclude));
                        break;
                    }
                }
            }
        }
        iwyuDiagnostics.set(doc.uri, diagnostics);
    });
}

function subscribeToDocumentChanges(configData: ConfigData, context: vscode.ExtensionContext, iwyuDiagnostics: vscode.DiagnosticCollection): void {
    if (vscode.window.activeTextEditor) {
        refreshDiagnostics(configData, vscode.window.activeTextEditor.document, iwyuDiagnostics);
    }
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                refreshDiagnostics(configData, editor.document, iwyuDiagnostics);
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => refreshDiagnostics(configData, e.document, iwyuDiagnostics))
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => iwyuDiagnostics.delete(doc.uri))
    );
}

class IwyuQuickFix implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] {
        // for each diagnostic entry that has the matching `code`, create a code action command
        return context.diagnostics
            .filter(diagnostic => diagnostic.code === IWYU_DIAGNISTIC)
            .map(diagnostic => this.createCommandCodeAction(diagnostic));
    }

    private createCommandCodeAction(diagnostic: vscode.Diagnostic): vscode.CodeAction {
        const action = new vscode.CodeAction('Run IWYU to fix includes.', vscode.CodeActionKind.QuickFix);
        action.command = { command: IWYU_COMMAND, title: 'Learn more about emojis', tooltip: 'Run IWYU to fix includes.' };
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        return action;
    }
}

export function activate(context: vscode.ExtensionContext) {
    log(INFO, "Extension activated");
    let workspacefolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ?
        vscode.workspace.workspaceFolders[0].uri.fsPath || "" : "";
    if (workspacefolder === "") {
        log(ERROR, "No workspace folder set. Not activating IWYU.");
        return;
    }
    let configData = new ConfigData(workspacefolder);

    const iwyuDiagnostics = vscode.languages.createDiagnosticCollection("iwyu");
    context.subscriptions.push(iwyuDiagnostics);

    subscribeToDocumentChanges(configData, context, iwyuDiagnostics);

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('cpp', new IwyuQuickFix(), {
            providedCodeActionKinds: IwyuQuickFix.providedCodeActionKinds
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand(IWYU_COMMAND, () => { iwyuCommand(configData); }));
}

export function deactivate() { }

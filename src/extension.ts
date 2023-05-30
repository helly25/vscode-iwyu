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
        this.compileCommandsData = this.parseCompileCommands();
    }

    private parseCompileCommands(): CompileCommandsData {
        let compileCommandsJson = this.compileCommandsJson();
        log(INFO, "Parsing: `" + compileCommandsJson + "`");
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

function iwyuRun(compileCommand: CompileCommand, configData: ConfigData) {
    let file = compileCommand.file;
    log(INFO, "Updating `" + file + "`");
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

    // Script and args for the python fix_includes.py.
    let pyscript = configData.config.get("fix_includes.py", "fix_includes.py");
    let pyargs = [];
    pyargs.push(configData.config.get("fix.comments", true)
        ? "--comments"
        : "--nocomments");
    pyargs.push(configData.config.get("fix.safe", true)
        ? "--safe_headers"
        : "--nosafe_headers");
    pyargs.push(configData.config.get("fix.reorder", true)
        ? "--reorder"
        : "--noreorder");
    if (configData.config.get("fix.ignore_re", "").trim() !== "") {
        pyargs.push("--ignore_re=" + configData.config.get("ignore_re", ""));
    }
    if (configData.config.get("fix.only_re", "").trim() !== "") {
        pyargs.push("--only_re=" + configData.config.get("only_re", ""));
    }
    pyscript += " " + pyargs.join(" ");

    let directory = compileCommand.directory;
    if (configData.config.get("debug", false)) {
        log(DEBUG, "Directory: `" + directory + "`");
        log(DEBUG, "IWYU Command: " + iwyu);
    }
    child_process.exec(iwyu, { cwd: directory }, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
            log(ERROR, err.message + stdout);
        } else if (configData.config.get("debug", false)) {
            log(DEBUG, "IWYU output:\n" + stdout);
        }
        if (!err) {
            let cmd = "";
            let iwyuFilterOutput = configData.config.get("filter_iwyu_output", "").trim();
            if (iwyuFilterOutput !== "") {
                let filtered: string[] = [];
                const filterRe = new RegExp("#include.*(" + iwyuFilterOutput + ")");
                stdout.split("\n").forEach((line: string) => {
                    if (!line.match(filterRe)) {
                        filtered.push(line);
                    }
                });
                stdout = filtered.join("\n");
                if (configData.config.get("debug", false)) {
                    log(DEBUG, "IWYU output filtered:\n" + stdout);
                }
            }
            cmd += ` | ${pyscript}`;
            log(DEBUG, "fix:\ncat <<EOF...IWYU-output...EOF)" + cmd);
            cmd = "(cat <<EOF\n" + stdout + "\nEOF\n)" + cmd;
            child_process.exec(cmd, { cwd: directory }, (err: Error | null, stdout: string, _stderr: string) => {
                if (err) {
                    log(ERROR, err.message);
                }
                log(INFO, stdout
                    .split(os.EOL)
                    .filter((element: string, _index, _array: string[]) => {
                        return element.includes("IWYU");
                    }).join(os.EOL));
                log(INFO, "Done `" + file + "`");
            });
        }
    });
}

function iwyuCommand(configData: ConfigData) {
    if (!vscode.window.activeTextEditor) {
        log(ERROR, "No editor.");
        return;
    }
    var editor: vscode.TextEditor = vscode.window.activeTextEditor;
    var fname: string = editor.document.fileName;
    if (!path.isAbsolute(fname)) {
        fname = path.resolve(configData.workspacefolder, fname);
    }

    let stat = util.promisify(fs.stat);
    stat(configData.compileCommandsJson()).then(stats => {
        configData.updateConfig();
        let commandsUpdated = stats.mtimeMs !== configData.compileCommandsData.mtimeMs;
        if (commandsUpdated) {
            configData.updateCompileCommands();
        }
        if (!configData.compileCommandsData.compileCommands.hasOwnProperty(fname)) {
            log(INFO, "Ignoring (not in `compile_commands.json`): " + fname);
            return;
        }
        if (configData.compileCommandsData.ignoreRe && fname.match(configData.compileCommandsData.ignoreRe)) {
            log(INFO, "Ignoring (matches `iwyu.fix.ignore_re`): " + fname);
            return;
        }
        if (configData.compileCommandsData.onlyRe && !fname.match(configData.compileCommandsData.onlyRe)) {
            log(INFO, "Ignoring (does not match `iwyu.fix.only_re`): " + fname);
            return;
        }
        editor.document.save();
        iwyuRun(configData.compileCommandsData.compileCommands[fname], configData);
    }).catch((err) => {
        log(ERROR, err);
    });
}

export function activate(context: vscode.ExtensionContext) {
    log(INFO, "Extension activated");
    let workspacefolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ?
        vscode.workspace.workspaceFolders[0].uri.fsPath || "" : "";
    if (workspacefolder === "") {
        log(ERROR, "No workspace folder set.");
    }
    let configData = new ConfigData(workspacefolder);

    let disposable = vscode.commands.registerCommand("iwyu.run", () => { iwyuCommand(configData); });
    context.subscriptions.push(disposable);
}

export function deactivate() { }

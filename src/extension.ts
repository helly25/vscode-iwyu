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

// Build up a map from abs-file -> entry (file, command/arguments, directory)
// The 'command' property will be set to just the command.
// The 'arguments' property will be set to all args (split by " ").
function parseCompileCommands(compileCommandsJson: string, workspacefolder: string): CompileCommandsData {
    let mtimeMs = fs.statSync(compileCommandsJson).mtimeMs;
    let compileCommands = JSON.parse(fs.readFileSync(compileCommandsJson, "utf8"));
    let cc: CompileCommandsMap = {};
    for (let entry of compileCommands) {
        let fname: string = entry.file;
        let directory: string = workspacefolder;
        if (entry.hasOwnProperty("directory")) {
            directory = entry.directory;
        }
        if (!path.isAbsolute(fname)) {
            fname = path.resolve(workspacefolder, directory, fname);
        }
        cc[fname] = entry;
        cc[fname].directory = directory;
        if (entry.hasOwnProperty("arguments")) {
            cc[fname].command = entry.arguments[0];
            cc[fname].arguments = entry.arguments.slice(1);
        } else {
            // TODO: Fix space in dir/filename of command and respect quotes.
            let args = entry.command.split(" ");
            cc[fname].command = args[0];
            cc[fname].arguments = args.slize(1);
        }
    }
    var config = vscode.workspace.getConfiguration("iwyu");
    let ignoreRe: string = config.get("fix.ignore_re", "");
    let onlyRe = config.get("fix.only_re", "");
    return {
        compileCommands: cc,
        mtimeMs: mtimeMs,
        ignoreRe: ignoreRe === "" ? null : new RegExp(ignoreRe),
        onlyRe: onlyRe === "" ? null : new RegExp(onlyRe),
    };
}

function runIwyu(compileCommand: CompileCommand, config: vscode.WorkspaceConfiguration) {
    let file = compileCommand.file;
    log(INFO, "Updating `" + file + "`");
    let iwyu = config.get("include-what-you-use", "include-what-you-use");

    // IWYU args
    let len = config.get("iwyu.max_line_length", 80);
    let args = [`-Xiwyu --max_line_length=${len}`];

    args.push(config
        .get("iwyu.keep", [])
        .map((x: string) => "-Xiwyu --keep=" + x)
        .join(" "));

    if (config.get("iwyu.transitive_includes_only", true)) {
        args.push("-Xiwyu --transitive_includes_only");
    }
    if (config.get("iwyu.no_fwd_decls", false)) {
        args.push("-Xiwyu --no_fwd_decls");
    }
    if (config.get("iwyu.no_default_mappings", false)) {
        args.push("-Xiwyu --no_default_mappings");
    }

    if (config.get("iwyu.mapping_file", "").trim() !== "") {
        args.push("-Xiwyu --mapping_file=" + config.get("mapping_file", ""));
    }
    if (config.get("iwyu.additional_params", "") !== "") {
        args.push(config.get("additional_params", ""));
    }
    iwyu += " " + args.concat(compileCommand.arguments).join(" ") + " 2>&1";

    // Script and args for the python fix_includes.py.
    let pyscript = config.get("fix_includes.py", "fix_includes.py");
    let pyargs = [];
    pyargs.push(config.get("fix.comments", true)
        ? "--comments"
        : "--nocomments");
    pyargs.push(config.get("fix.safe", true)
        ? "--safe_headers"
        : "--nosafe_headers");
    pyargs.push(config.get("fix.reorder", true)
        ? "--reorder"
        : "--noreorder");
    if (config.get("fix.ignore_re", "").trim() !== "") {
        pyargs.push("--ignore_re=" + config.get("ignore_re", ""));
    }
    if (config.get("fix.only_re", "").trim() !== "") {
        pyargs.push("--only_re=" + config.get("only_re", ""));
    }
    pyscript += " " + pyargs.join(" ");

    let directory = compileCommand.directory;
    if (config.get("debug", false)) {
        log(DEBUG, "Directory: `" + directory + "`");
        log(DEBUG, "IWYU Command: " + iwyu);
    }
    child_process.exec(iwyu, { cwd: directory }, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
            log(ERROR, err.message + stdout);
        } else if (config.get("debug", false)) {
            log(DEBUG, "IWYU\n" + stdout);
        }
        if (!err) {
            let cmd = "";
            let iwyuFilterOutput = config.get("filter_iwyu_output", "").trim();
            if (iwyuFilterOutput !== "") {
                let filtered: string[] = [];
                const filterRe = new RegExp("#include.*(" + iwyuFilterOutput + ")");
                stdout.split("\n").forEach((line: string) => {
                    if (!line.match(filterRe)) {
                        filtered.push(line);
                    }
                });
                stdout = filtered.join("\n");
                if (config.get("debug", false)) {
                    log(DEBUG, "IWYU filtered:\n" + stdout);
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

export function activate(context: vscode.ExtensionContext) {
    log(INFO, "Extension activated");
    var workspacefolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ?
        vscode.workspace.workspaceFolders[0].uri.fsPath || "" : "";
    if (workspacefolder === "") {
        log(ERROR, "No workspace folder set.");
    }
    var config = vscode.workspace.getConfiguration("iwyu");
    var compileCommandsJson: string = config
        .get("compile_commands.json", "${workspaceFolder}/compile_commands.json")
        .replace("${workspaceRoot}", workspacefolder)
        .replace("${workspaceFolder}", workspacefolder);
    var compileCommandsData = parseCompileCommands(compileCommandsJson, workspacefolder);
    let disposable = vscode.commands.registerCommand("iwyu.run", () => {
        if (!vscode.window.activeTextEditor) {
            log(ERROR, "No editor.");
            return;
        }
        var editor: vscode.TextEditor = vscode.window.activeTextEditor;
        var fname: string = editor.document.fileName;
        if (!path.isAbsolute(fname)) {
            fname = path.resolve(workspacefolder, fname);
        }

        let stat = util.promisify(fs.stat);
        stat(compileCommandsJson).then(stats => {
            let newConfig = vscode.workspace.getConfiguration("iwyu");
            let commandsUpdated = stats.mtimeMs !== compileCommandsData.mtimeMs;
            let configUpdated = newConfig !== config;
            if (commandsUpdated) {
                log(INFO, "Parsing: `" + compileCommandsJson+"`");
                compileCommandsData = parseCompileCommands(compileCommandsJson, workspacefolder);
            }
            if (configUpdated) {
                if (config.get("debug", false)) {
                    log(DEBUG, "Extension config updated.");
                }
                config = newConfig;
            }
            if (!compileCommandsData.compileCommands.hasOwnProperty(fname)) {
                log(INFO, "Ignoring (not in `compile_commands.json`): " + fname);
                return;
            }
            if (compileCommandsData.ignoreRe && fname.match(compileCommandsData.ignoreRe)) {
                log(INFO, "Ignoring (matches `iwyu.fix.ignore_re`): " + fname);
                return;
            }
            if (compileCommandsData.onlyRe && !fname.match(compileCommandsData.onlyRe)) {
                log(INFO, "Ignoring (does not match `iwyu.fix.only_re`): " + fname);
                return;
            }
            editor.document.save();
            runIwyu(compileCommandsData.compileCommands[fname], config);
        }).catch((err) => {
            log(ERROR, err);
        });
    });
    context.subscriptions.push(disposable);
}

export function deactivate() { }

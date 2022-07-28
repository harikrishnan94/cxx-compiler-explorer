import { workspace, Uri, TextDocument, OutputChannel, window, FileSystemWatcher, Disposable, ProgressLocation, Progress, CancellationToken } from "vscode";
import * as Path from "path";
import { AsmProvider } from "./provider";
import { ChildProcess, spawn } from 'child_process';
import { TextDecoder } from "util";
import { existsSync } from "fs";
import { splitLines } from "./utils";

interface CompileCommand {
    directory: string,
    command: string,
    file: string,
    arguments: string[]
}

const cxxfiltExe = 'c++filt';

export class CompilationDatabase implements Disposable {
    private compileCommandsFile: Uri;
    private commands: Map<string, CompileCommand>;
    private watcher: FileSystemWatcher;

    private static compdbs: Map<Uri, CompilationDatabase> = new Map();

    constructor(compileCommandsFile: Uri, commands: Map<string, CompileCommand>) {
        this.compileCommandsFile = compileCommandsFile;
        this.commands = commands;
        this.watcher = workspace.createFileSystemWatcher(this.compileCommandsFile.path);

        const load = async () => {
            this.commands = await CompilationDatabase.load(this.compileCommandsFile);
        };
        this.watcher.onDidChange(async () => await load());
        this.watcher.onDidDelete(() => {
            CompilationDatabase.compdbs.get(this.compileCommandsFile)?.dispose();
            CompilationDatabase.compdbs.delete(this.compileCommandsFile);
        });
    }

    static async for(srcUri: Uri): Promise<CompilationDatabase> {
        const buildDirectory = resolvePath(workspace.getConfiguration('compilerexplorer')
            .get<string>('compilationDirectory', '${workspaceFolder}'), srcUri);
        const compileCommandsFile = Uri.joinPath(Uri.parse(buildDirectory), 'compile_commands.json');

        let compdb = CompilationDatabase.compdbs.get(compileCommandsFile);
        if (compdb) return compdb;

        const commands = await CompilationDatabase.load(compileCommandsFile);

        compdb = new CompilationDatabase(compileCommandsFile, commands);
        this.compdbs.set(compileCommandsFile, compdb);

        return compdb;
    }

    async compile(src: Uri, extraArgs: string[]): Promise<string> {
        const ccommand = this.get(src);
        if (!ccommand) throw new Error("cannot find compilation command");

        const start = new Date().getTime();

        const progressOption = {
            location: ProgressLocation.Notification,
            title: "C++ Compiler Explorer",
            cancellable: true
        }
        const asm = await window.withProgress(progressOption,
            async (progress, ctok): Promise<string | Error> => {
                progress.report({ message: "Compilation in progress" });
                return await this.runCompiler(ctok, ccommand, extraArgs);
            });

        const elapsed = (new Date().getTime() - start) / 1000;
        if (asm instanceof Error) throw asm;

        getOutputChannel().appendLine(`Compilation succeeded: ${asm.length} bytes, ${elapsed} s`);

        return asm;
    }

    static disposable(): Disposable {
        return new Disposable(() => {
            for (let compdb of this.compdbs) {
                compdb[1].dispose();
            }
        });
    }

    private static async load(compileCommandsFile: Uri): Promise<Map<string, CompileCommand>> {
        getOutputChannel().appendLine(`Loading Compilation Database from: ${compileCommandsFile.toString()}`);

        const compileCommands = new TextDecoder().decode(await workspace.fs.readFile(compileCommandsFile));
        const commands: CompileCommand[] = JSON.parse(compileCommands);
        CompilationDatabase.preprocess(commands);

        let ccommands = new Map<string, CompileCommand>();
        for (let command of commands) {
            ccommands.set(command.file, command);
        }

        return ccommands;
    }

    private static preprocess(commands: CompileCommand[]) {
        for (let ccommand of commands) {
            if (ccommand.command.length > 0) ccommand.arguments = splitWhitespace(ccommand.command);
            ccommand.command = "";

            let isOutfile = false;
            ccommand.arguments = ccommand.arguments.filter(arg => {
                if (!isOutfile) {
                    isOutfile = arg === "-o";
                    return isOutfile ? false : arg !== "-c" && arg !== "-g";
                } else {
                    isOutfile = false;
                    return false;
                }
            });

            ccommand.arguments.push('-g', '-S', '-o', '-');
        }
    }

    private async runCompiler(ctok: CancellationToken, ccommand: CompileCommand, extraArgs: string[]): Promise<string | Error> {
        const cxxfiltExe = getCxxFiltExe(ccommand.arguments[0]);
        const command = ccommand.arguments[0];
        const args = [...ccommand.arguments.slice(1), ...extraArgs];

        getOutputChannel().appendLine(`Compiling using: ${command} ${args.join(' ')}`);

        const checkStdErr = async (process: ChildProcess) => {
            let stderr = "";
            for await (let chunk of process.stderr!) {
                stderr += chunk;
            }
            if (stderr.length > 0) {
                getOutputChannel().appendLine(stderr);
                getOutputChannel().show();
            }

            try {
                if (await onExit(process)) return false;
            } catch (e) {
                return false;
            }

            return true;
        };

        const cxx = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const cxxfilt = spawn(cxxfiltExe, [], { stdio: ['pipe', 'pipe', 'pipe'] });

        cxxfilt.stdin.cork();
        for await (let chunk of cxx.stdout!) {
            if (ctok.isCancellationRequested) return Error("operation cancelled");
            cxxfilt.stdin.write(chunk);
        }
        cxxfilt.stdin.uncork();
        cxxfilt.stdin.end();

        if (!await checkStdErr(cxx)) return Error("compilation failed");

        let asm = ""
        for await (let chunk of cxxfilt.stdout!) {
            if (ctok.isCancellationRequested) return Error("operation cancelled");
            asm += chunk;
        }
        if (!await checkStdErr(cxxfilt)) return Error("compilation failed");

        return splitLines(asm).filter((line) => {
            line = line.trimStart();
            return !line.startsWith('#') && !line.startsWith(';')
        }).join('\n');
    }

    private get(srcUri: Uri): CompileCommand | undefined {
        return this.commands.get(srcUri.fsPath);
    }

    dispose() {
        this.commands.clear();
        this.watcher.dispose();
    }
}

export function getAsmUri(source: TextDocument): Uri {
    const sourceUri = source.uri;

    // by default just replace file extension with '.S'
    const asmUri = sourceUri.with({
        scheme: AsmProvider.scheme,
        path: pathWithoutExtension(sourceUri.path) + ".S",
    });

    return asmUri;
}

/**
 * Remove extension from provided path.
 */
function pathWithoutExtension(path: string): string {
    return path.slice(0, path.lastIndexOf(".")) || path;
}

// Resolve path with almost all variable substitution that supported in
// Debugging and Task configuration files
function resolvePath(path: string, srcUri: Uri): string {
    const workspacePath = workspace.getWorkspaceFolder(srcUri)?.uri.fsPath!;

    const variables: Record<string, string> = {
        // the path of the folder opened in VS Code
        workspaceFolder: workspacePath,
        // the name of the folder opened in VS Code without any slashes (/)
        workspaceFolderBasename: Path.parse(workspacePath).name,
        // the current opened file
        file: path,
        // the current opened file's workspace folder
        fileWorkspaceFolder:
            workspace.getWorkspaceFolder(Uri.file(path))?.uri.fsPath || "",
        // the current opened file relative to workspaceFolder
        relativeFile: Path.relative(workspacePath, path),
        // the character used by the operating system to separate components in file paths
        pathSeparator: Path.sep,
    };

    const variablesRe = /\$\{(.*?)\}/g;
    const resolvedPath = path.replace(
        variablesRe,
        (match: string, varName: string) => {
            const value = variables[varName];
            if (value !== undefined) {
                return value;
            } else {
                // leave original (unsubstituted) value if there is no such variable
                return match;
            }
        }
    );

    // normalize a path, reducing '..' and '.' parts
    return Path.normalize(resolvedPath);
}

let outputChannel: OutputChannel | undefined = undefined;
export function getOutputChannel(): OutputChannel {
    if (outputChannel === undefined)
        outputChannel = window.createOutputChannel("C/C++ Compiler Explorer", "shellscript");
    return outputChannel;
}

function getCxxFiltExe(compExe: string): string {
    let parsed = Path.parse(compExe)
    parsed.name = parsed.name.replace('clang++', cxxfiltExe)
        .replace('clang', cxxfiltExe)
        .replace('g++', cxxfiltExe)
        .replace('gcc', cxxfiltExe);

    const cxxfilt = Path.join(parsed.dir, parsed.name, parsed.ext);
    if (!existsSync(cxxfilt)) return cxxfiltExe;

    return cxxfilt;
}

async function onExit(childProcess: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
        childProcess.once('exit', (code: number, signal: string) => {
            resolve(code);
        });
        childProcess.once('error', (err: Error) => {
            reject(err);
        });
    });
}

function splitWhitespace(str: string): string[] {
    let quoteChar: string | undefined = undefined;
    let shouldEscape = false;
    let strs: string[] = [];

    let i = 0;
    let strStart = 0;
    for (let ch of str) {
        switch (ch) {
            case '\\':
                shouldEscape = !shouldEscape;
                break;

            case '\'':
                if (!shouldEscape) {
                    if (quoteChar == '\'') quoteChar = undefined;
                    else quoteChar = '\'';
                }
                break;
            case '"':
                if (!shouldEscape) {
                    if (quoteChar == '"') quoteChar = undefined;
                    else quoteChar = '"';
                }
                break;

            case ' ':
                if (!quoteChar) {
                    const slice = str.slice(strStart, i);
                    if (slice.length > 0) strs.push(slice);
                    strStart = i + 1;
                }

            default:
                break;
        }

        i++;
    }

    const slice = str.slice(strStart, i);
    if (slice.length > 0) strs.push(slice);

    return strs;
}

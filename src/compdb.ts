import { workspace, Uri, TextDocument, OutputChannel, window, FileSystemWatcher, Disposable } from "vscode";
import * as Path from "path";
import { AsmProvider } from "./provider";
import { spawnSync } from "child_process";
import { TextDecoder } from "util";
import { existsSync } from "fs";

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

    compile(src: Uri, extraArgs: string[]): string {
        const ccommand = this.get(src);
        if (!ccommand) throw new Error("cannot find compilation command");

        const cxxfilt = getCxxFiltExe(ccommand.arguments[0]);
        const command = ccommand.arguments[0];
        const args = [...ccommand.arguments.slice(1), ...extraArgs];

        getOutputChannel().appendLine(`Compiling using: ${command} ${args.join(' ')}`);

        const spawn = (command: string, args: string[], stdin?: string): string | undefined => {
            let { stdout, stderr, status } = spawnSync(command, args, {
                input: stdin,
                "encoding": 'utf-8',
                timeout: 30000 // 30 seconds
            });
            if (status && status != 0) {
                getOutputChannel().appendLine(stderr);
                throw new Error("cannot compile file due to compilation errors");
            }

            if (stdout)
                getOutputChannel().appendLine(`Output: ${stdout.length} lines`);
            return stdout;
        };

        const asm = spawn(command, args);
        const demangled = spawn(cxxfilt, [], asm);
        return demangled ? demangled : (asm ? asm : "");
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
            if (ccommand.command.length > 0) {
                ccommand.arguments = ccommand.command.split(/(\s+)/).filter(arg => !arg.match((/(\s+)/)));
            }
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

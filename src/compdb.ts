import { workspace, Uri, OutputChannel, window, FileSystemWatcher, Disposable, ProgressLocation, CancellationToken, CancellationTokenSource } from "vscode";
import * as Path from "path";
import { AsmProvider } from "./provider";
import { SpawnOptionsWithStdioTuple, StdioPipe, StdioNull, ChildProcess, spawn } from 'child_process';
import { TextDecoder } from "util";
import { existsSync, promises as fs } from "fs";
import { splitLines } from "./utils";
import * as api from 'vscode-cmake-tools';

interface CompileCommand {
    directory: string,
    command: string,
    file: string,
    arguments: string[]
}

const cxxfiltExe = 'c++filt';

export class CompilationDatabase implements Disposable {
    private compileCancellationTokenSource?: CancellationTokenSource = undefined;
    private compileCommandsFile: Uri;
    private commands: Map<string, CompileCommand>;
    private cxxFiltExeCache: Map<string, string> = new Map();
    private watcher: FileSystemWatcher|undefined;
    private projectChange: Disposable|undefined;
    private codeModelChange: Disposable|undefined;
    private cmakeTools: api.CMakeToolsApi|undefined;
    private project: api.Project|undefined;

    private static compdbs: Map<Uri, CompilationDatabase> = new Map();

    constructor(compileCommandsFile: Uri, commands: Map<string, CompileCommand>) {
        this.compileCommandsFile = compileCommandsFile;
        this.commands = commands;

        if (commands.size === 0) {
            let cmakeTools = api.getCMakeToolsApi(api.Version.v1);
            if (cmakeTools === undefined)
                return;
            cmakeTools.then(api => {
                this.cmakeTools = api;
                if (this.cmakeTools === undefined)
                    return;

                this.projectChange = this.cmakeTools.onActiveProjectChanged(
                    this.onActiveProjectChanged, this);
                if (workspace.workspaceFolders !== undefined) {
                    const projectUri = workspace.workspaceFolders[0].uri;
                    this.onActiveProjectChanged(projectUri);
                }
            });
            return;
        }

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

        try {
            const commands = await CompilationDatabase.load(compileCommandsFile);
            if (commands.size == 0) throw new Error('compile_commands.json is empty');
    
            compdb = new CompilationDatabase(compileCommandsFile, commands);
            this.compdbs.set(compileCommandsFile, compdb);
        } catch (e) {
            compdb = new CompilationDatabase(compileCommandsFile, new Map);
            this.compdbs.set(compileCommandsFile, compdb);
        }

        return compdb;
    }

    get(srcUri: Uri): CompileCommand | undefined {
        return this.commands.get(srcUri.fsPath);
    }

    async compile(src: Uri, customCommand: string[]): Promise<string> {
        const ccommand = this.get(src);
        if (!ccommand) throw new Error("cannot find compilation command");

        // cancel possible previous compilation
        this.compileCancellationTokenSource?.cancel();

        const ctokSource = new CancellationTokenSource();
        this.compileCancellationTokenSource = ctokSource;

        try {
            const start = new Date().getTime();

            const progressOption = {
                location: ProgressLocation.Notification,
                title: "C++ Compiler Explorer",
                cancellable: true
            };

            const asm = await window.withProgress(progressOption,
                async (progress, ctok) => {
                    progress.report({ message: "Compilation in progress" });
                    ctok.onCancellationRequested(() => ctokSource.cancel());
                    return await this.runCompiler(ctokSource.token, ccommand, customCommand);
                });
            const elapsed = (new Date().getTime() - start) / 1000;
            getOutputChannel().appendLine(`Compilation succeeded: ${asm.length} bytes, ${elapsed} s`);
            return asm;
        } finally {
            this.compileCancellationTokenSource = undefined;
        }
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
            let filePath = command.file;
            if(!Path.isAbsolute(filePath)) {
                filePath = await fs.realpath(Path.join(command.directory, command.file));
            }
            ccommands.set(filePath, command);
        }

        return ccommands;
    }

    private static preprocess(commands: CompileCommand[]) {
        for (let ccommand of commands) {
            ccommand.arguments = constructCompileCommand(ccommand.command, ccommand.arguments);
            ccommand.arguments = ccommand.arguments.filter((arg) => arg != ccommand.file);
            ccommand.command = "";
        }
    }

    private async runCompiler(ctok: CancellationToken, ccommand: CompileCommand, customCommand: string[]): Promise<string> {
        const compileArguments = customCommand.length != 0 ? customCommand : ccommand.arguments;
        const cxxfiltExe = await this.getCxxFiltExe(compileArguments[0]);
        const command = compileArguments[0];
        const args = [...compileArguments.slice(1), ccommand.file, '-g', '-S', '-o', '-'];

        getOutputChannel().appendLine(`Compiling using: ${command} ${args.join(' ')}`);

        let commandOptions: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> = { stdio: ['ignore', 'pipe', 'pipe'], shell: true }
        if (existsSync(ccommand.directory)) {
            commandOptions.cwd = ccommand.directory;
        }
        const cxx = spawn(command, args, commandOptions);
        const cxxfilt = spawn(cxxfiltExe, [], { stdio: ['pipe', 'pipe', 'pipe'] });

        try {
            cxxfilt.stdin.cork();
            for await (let chunk of cxx.stdout!) {
                if (ctok.isCancellationRequested) throw new Error("operation cancelled");
                cxxfilt.stdin.write(chunk);
            }
            cxxfilt.stdin.uncork();
            cxxfilt.stdin.end();

            if (!await this.checkStdErr(cxx)) throw new Error("compilation failed");

            let asm = ""
            for await (let chunk of cxxfilt.stdout!) {
                if (ctok.isCancellationRequested) throw new Error("operation cancelled");
                asm += chunk;
            }
            if (!await this.checkStdErr(cxxfilt)) throw new Error("compilation failed");

            return splitLines(asm).filter((line) => {
                line = line.trimStart();
                return !line.startsWith('#') && !line.startsWith(';')
            }).join('\n');
        } catch (e) {
            cxx.kill();
            cxxfilt.kill();
            throw e;
        }
    }

    private async getCxxFiltExe(compExe: string): Promise<string> {
        let cxxfiltExe = this.cxxFiltExeCache.get(compExe)
        if (cxxfiltExe !== undefined)
            return cxxfiltExe;

        cxxfiltExe = await this.findCxxFiltExe(compExe);
        this.cxxFiltExeCache.set(compExe, cxxfiltExe);

        return cxxfiltExe;
    }

    private async findCxxFiltExe(compExe: string): Promise<string> {
        let parsed = Path.parse(compExe)
        let findExePath = async (dir: string | undefined) => {
            if (dir !== undefined) {
                const cxxfiltNameWithExt = cxxfiltExe + parsed.ext;
                for (let file of await fs.readdir(dir)) {
                    if (file.endsWith(cxxfiltNameWithExt)) {
                        return Path.resolve(dir, file);
                    }
                }
            }

            return undefined;
        };

        // Use PATH or base dir of compiler to find c++filt executable
        if (parsed.dir.length == 0) {
            // Compiler base path is empty, so check expand in PATH.
            const compExeDir = await this.findExecutablePath(compExe);
            const cxxfilt = await findExePath(compExeDir);
            if (cxxfilt !== undefined) {
                return cxxfilt;
            }
        } else {
            // Use the path in which the compiler is installed.
            const compExeDir = parsed.dir;
            const cxxfilt = await findExePath(compExeDir);
            if (cxxfilt !== undefined) {
                return cxxfilt;
            }
        }

        // Else guess the path and hope it turns useful.
        parsed.name = parsed.name.replace('clang++', cxxfiltExe)
            .replace('clang', cxxfiltExe)
            .replace('g++', cxxfiltExe)
            .replace('gcc', cxxfiltExe)
            .replace('c++', cxxfiltExe)
            .replace('cc', cxxfiltExe);

        const cxxfilt = Path.join(parsed.dir, parsed.name, parsed.ext);
        if (!existsSync(cxxfilt)) return cxxfiltExe;

        return cxxfilt;
    }

    private async findExecutablePath(exe: string): Promise<string | undefined> {
        let commandOptions: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioNull> = { stdio: ['ignore', 'pipe', 'ignore'] }
        const which = spawn("which", [exe], commandOptions);

        try {
            let resolvedPath = "";
            for await (let chunk of which.stdout!) {
                resolvedPath += chunk.toString();
            }
            if (!await this.checkStdErr(which)) return Path.parse(resolvedPath).dir;
        } catch (e) {
            which.kill();
        }
        return undefined;
    }

    private async checkStdErr(process: ChildProcess) {
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
    }

    private async onActiveProjectChanged(path: Uri | undefined) {
        if (this.codeModelChange !== undefined) {
            this.codeModelChange.dispose();
            this.codeModelChange = undefined;
        }

        if (path === undefined)
            return;

        this.cmakeTools?.getProject(path).then(project => {
            this.project = project;
            this.codeModelChange =
                this.project?.onCodeModelChanged(this.onCodeModelChanged, this);
            this.onCodeModelChanged().then(() => {
                if (this.commands.size === 0)
                    throw new Error('CMakeTools: No compile commands found');
            })
        });
    }

    private async onCodeModelChanged() {
        const content = this.project?.codeModel;
        if (content === undefined)
            return;

        if (content.toolchains === undefined)
            return;

        content.configurations.forEach(configuration => {
            configuration.projects.forEach(project => {
                let sourceDirectory = project.sourceDirectory;
                project.targets.forEach(target => {
                    if (target.sourceDirectory !== undefined)
                        sourceDirectory = target.sourceDirectory;

                    let commandLine: string[] = [];
                    target.fileGroups?.forEach(fileGroup => {
                        if (fileGroup.language === undefined)
                            return;

                        const compiler = content.toolchains?.get(fileGroup.language);
                        if (compiler === undefined)
                            return;

                        commandLine.push(compiler.path);

                        fileGroup.compileCommandFragments?.forEach(commands => {
                            commands.split(/\s/g).forEach(
                                command => { commandLine.push(command); });
                        });

                        let compilerName =
                            compiler.path.substring(compiler.path.lastIndexOf(Path.sep) + 1)
                                .toLowerCase();
                        if (compilerName.endsWith('.exe'))
                            compilerName = compilerName.substring(0, compilerName.length - 4);

                        const isMsvc = compilerName === 'cl' || compilerName === 'clang-cl';

                        const defFlag = isMsvc ? '/D' : '-D';
                        fileGroup.defines?.forEach(
                            define => { commandLine.push(`${defFlag}${define}`); });

                        const incFlag = isMsvc ? '/I' : '-I';
                        fileGroup.includePath?.forEach(
                            include => { commandLine.push(`${incFlag}${include.path}`); });

                        const isClang = compilerName.includes("clang");
                        if (isClang) {
                            if (target.sysroot !== undefined)
                                commandLine.push(`--sysroot=${target.sysroot}`);
                            if (compiler.target !== undefined)
                                commandLine.push(`--target=${compiler.target}`);
                        }

                        fileGroup.sources.forEach(source => {
                            const file = sourceDirectory.length != 0
                                ? sourceDirectory + Path.sep + source
                                : source;
                            const command: CompileCommand = {
                                directory: sourceDirectory,
                                command: compiler.path,
                                file: file,
                                arguments: commandLine
                            };
                            this.commands.set(file, command);
                        });
                    });
                });
            });
        });
    }

    dispose() {
        this.compileCancellationTokenSource?.cancel();
        this.compileCancellationTokenSource?.dispose();
        this.commands.clear();
        this.watcher?.dispose();
        this.projectChange?.dispose();
        this.codeModelChange?.dispose();
    }
}

export function constructCompileCommand(command: string, args: string[]): string[] {
    if (command && command.length > 0) args = splitWhitespace(command);

    let isOutfile = false;
    args = args.filter(arg => {
        if (!isOutfile) {
            isOutfile = arg === "-o";
            return isOutfile ? false : arg !== "-c" && arg !== "-g";
        } else {
            isOutfile = false;
            return false;
        }
    });

    return args;
}

export function getAsmUri(srcUri: Uri): Uri {
    // by default just replace file extension with '.S'
    const asmUri = srcUri.with({
        scheme: AsmProvider.scheme,
        path: pathWithoutExtension(srcUri.path) + ".S",
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
        if (ch === '\\') {
            // Catch the escape char in the first place!
            // Either the last char was the escape char
            // then reset or the last char was not the
            // escape char then enable escaping for the
            // next char.
            shouldEscape = !shouldEscape;
        } else {
            switch (ch) {
                case '\'':
                case '\"': {
                    if (!shouldEscape) {
                        if (quoteChar === ch) {
                            quoteChar = undefined;
                        } else {
                            quoteChar = ch;
                        }
                    }
                    break;
                }
                case ' ': {
                    if (!quoteChar) {
                        const slice = str.slice(strStart, i);
                        if (slice.length > 0) {
                            strs.push(slice);
                        }
                        strStart = i + 1;
                    }
                    break;
                }
                default:
                    break;
            }
            // Always reset the flag if it is not the escape char
            // because escaping should only apply to the next char
            // that follows the escape char.
            shouldEscape &&= !shouldEscape;
        }
        i++;
    }

    const slice = str.slice(strStart, i);
    if (slice.length > 0) {
        strs.push(slice);
    }
    return strs;
}

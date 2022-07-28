import { workspace, languages, Uri, TextDocument, OutputChannel, window } from "vscode";
import * as Path from "path";
import { AsmProvider } from "./provider";
import { spawnSync } from "child_process";

interface CompileCommands {
    commands: CompileCommand[]
}

interface CompileCommand {
    directory: string,
    command: string,
    file: string,
    arguments: string[],
    output: string
}

function compile(ccommand: CompileCommand, extraArgs: string[]): string {
    const getExecCommand = () => {
        const args = ccommand.arguments;
        return { command: args[0], args: [...args.slice(1), ...extraArgs, "-o", ccommand.output] }
    };
    const { command, args } = getExecCommand();

    getOutputChannel().appendLine([command, ...args].join(" "));
    const { stdout, stderr, status } = spawnSync(command, args, {
        encoding: 'utf-8'
    });
    getOutputChannel().appendLine(stderr);

    if (status != 0)
        throw new Error("cannot compile file due to compilation errors");

    return stdout;
}

let outputChannel: OutputChannel | undefined;
export function getOutputChannel(): OutputChannel {
    if (outputChannel == undefined)
        outputChannel = window.createOutputChannel("C/C++ Compiler Explorer", "shellscript");
    return outputChannel;
}

export function getAsmUri(source: TextDocument, extraArgs: string[]): Uri {
    const sourceUri = source.uri;
    const configuration = workspace.getConfiguration("", sourceUri);

    type Associations = Record<string, string>;
    const associations = configuration.get<Associations>(
        "compilerexplorer.associations"
    );

    // by default just replace file extension with '.S'
    const defaultUri = sourceUri.with({
        scheme: AsmProvider.scheme,
        path: pathWithoutExtension(sourceUri.path) + ".S",
    });

    if (associations === undefined) {
        return defaultUri;
    }

    for (const key in associations) {
        const match = languages.match({ pattern: key }, source);
        if (match > 0) {
            const associationRule = associations[key];
            return sourceUri.with({
                scheme: AsmProvider.scheme,
                path: resolvePath(sourceUri.fsPath, associationRule),
            });
        }
    }

    return defaultUri;
}

/**
 * Remove extension from provided path.
 */
function pathWithoutExtension(path: string): string {
    return path.slice(0, path.lastIndexOf(".")) || path;
}

// Resolve path with almost all variable substitution that supported in
// Debugging and Task configuration files
function resolvePath(path: string, associationRule: string): string {
    if (workspace.workspaceFolders === undefined) {
        return path;
    }

    const parsedFilePath = Path.parse(path);
    const workspacePath = workspace.workspaceFolders[0].uri.fsPath;

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
        // the current opened file's dirname relative to workspaceFolder
        relativeFileDirname: Path.relative(workspacePath, parsedFilePath.dir),
        // the current opened file's basename
        fileBasename: parsedFilePath.base,
        // the current opened file's basename with no file extension
        fileBasenameNoExtension: parsedFilePath.name,
        // the current opened file's dirname
        fileDirname: parsedFilePath.dir,
        // the current opened file's extension
        fileExtname: parsedFilePath.ext,
        // the character used by the operating system to separate components in file paths
        pathSeparator: Path.sep,
        // same as relativeFileDirname, kept for compatibility with old configs
        // TODO: remove in future releases
        relativeFileDir: Path.relative(workspacePath, parsedFilePath.dir),
    };

    const variablesRe = /\$\{(.*?)\}/g;
    const resolvedPath = associationRule.replace(
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

"use strict";

import { window, workspace, Uri, OutputChannel } from "vscode";
import * as fs from "fs";
import * as Path from "path";
import { resolvePath, arrayEquals } from "./utils";
import * as child_process from "child_process";
import {
	JsonObject,
	JsonProperty,
	JsonConvert,
	OperationMode,
	ValueCheckingMode
} from "json2typescript";

@JsonObject("CompileCommand")
class CompileCommand {
	@JsonProperty("file", String)
	private file: string = "";

	@JsonProperty("command", String, "isOptional")
	private _command: string = "";

	@JsonProperty("arguments", [String], "isOptional")
	private _arguments: string[] = [];

	@JsonProperty("directory", String)
	directory: string = "";

	uri: Uri = Uri.file("");
	command: string = "";
	args: string[] = [""];

	process() {
		const commands = (this._command.length
			? this._command.split(" ")
			: this._arguments
		).filter(arg => arg.length > 0);

		this.uri = Uri.file(Path.resolve(this.directory, this.file));
		this.command = commands[0];
		this.args = this.sanitizeArgs(commands.slice(1));
	}

	getDisassembleCommand(outFile: string) {
		let args = [
			this.command,
			"-g",
			"-S",
			"-masm=intel",
			"-o",
			outFile
		].concat(this.args);

		return this.getCommand(args);
	}

	getPreprocessCommand(outFile: string) {
		let args = [this.command, "-E", "-o", outFile].concat(this.args);

		return this.getCommand(args);
	}

	getLLVMDisassembleCommand(outFile: string) {
		let args = [
			this.command,
			"-g",
			"-S",
			"-emit-llvm",
			"-o",
			outFile
		].concat(this.args);

		return this.getCommand(args);
	}

	private getCommand(args: string[]) {
		let command = "";

		args.forEach(arg => {
			command += arg + " ";
		});

		return command;
	}

	private sanitizeArgs(args: string[]) {
		let isOutfile = false;
		return args.filter(arg => {
			if (!isOutfile) {
				isOutfile = arg === "-o";
				return isOutfile ? false : arg !== "-c" && arg !== "-g";
			} else {
				isOutfile = false;
				return false;
			}
		});
	}
}

class CompileInfo {
	uri: Uri;
	srcUri: Uri;
	command: string;
	compilationDirectory: string;
	extraArgs: string[] = [];

	constructor(
		uri: Uri,
		srcUri: Uri,
		command: string,
		compilationDirectory: string
	) {
		this.uri = uri;
		this.srcUri = srcUri;
		this.command = command;
		this.compilationDirectory = compilationDirectory;
	}

	extraArgsChanged(extraArgs: string[]) {
		return !arrayEquals(extraArgs, this.extraArgs);
	}
}

export class CompileCommands {
	private static errorChannel: OutputChannel;
	private static compileCommands = new Map<string, CompileInfo>();
	private static asmUriMap = new Map<string, Uri>();
	private static llvmUriMap = new Map<string, Uri>();
	private static preprocessUriMap = new Map<string, Uri>();
	private static compileTimestamps = new Map<string, Date>();
	private static outDir = resolvePath(
		workspace.getConfiguration("compilerexplorer").get<string>("outDir") +
			"/"
	);
	private static extraArgs: string[] = [];

	static setExtraCompileArgs(extraArgs: string[]) {
		this.extraArgs = extraArgs;
	}

	static getExtraCompileArgs() {
		return this.extraArgs.join(" ");
	}

	static compile(uri: Uri) {
		const compileInfo = this.getCompileInfo(uri);

		if (compileInfo !== undefined) {
			if (this.needCompilation(compileInfo)) {
				return this.execCompileCommand(compileInfo);
			} else {
				return true;
			}
		} else {
			return false;
		}
	}

	static getSrcUri(uri: Uri) {
		const compileInfo = this.compileCommands.get(uri.path);

		return compileInfo ? compileInfo.srcUri : undefined;
	}

	static getAsmUri(uri: Uri) {
		return this.asmUriMap.get(uri.path);
	}

	static getLLVMUri(uri: Uri) {
		return this.llvmUriMap.get(uri.path);
	}

	static getPreprocessUri(uri: Uri) {
		return this.preprocessUriMap.get(uri.path);
	}

	static init(errorChannel: OutputChannel): boolean {
		const compileCommandsFile = this.getCompileCommandsPath();

		if (fs.existsSync(compileCommandsFile)) {
			let compileCommands = this.parseCompileCommands(
				compileCommandsFile
			);

			compileCommands.forEach((compileCommand: CompileCommand) => {
				CompileCommands.processCompileCommand(compileCommand);
			});

			this.errorChannel = errorChannel;
			this.createOutputDirectory();

			return true;
		}

		return false;
	}

	private static processCompileCommand(compileCommand: CompileCommand) {
		compileCommand.process();

		const srcUri = compileCommand.uri;
		const asmUri = this.encodeAsmUri(srcUri);
		const llvmUri = this.encodeLLVMUri(srcUri);
		const preprocessUri = this.encodePreprocessUri(srcUri);

		this.asmUriMap.set(srcUri.path, asmUri);
		this.compileCommands.set(
			asmUri.path,
			new CompileInfo(
				asmUri,
				srcUri,
				compileCommand.getDisassembleCommand(asmUri.path),
				compileCommand.directory
			)
		);

		this.llvmUriMap.set(srcUri.path, llvmUri);
		this.compileCommands.set(
			llvmUri.path,
			new CompileInfo(
				llvmUri,
				srcUri,
				compileCommand.getLLVMDisassembleCommand(llvmUri.path),
				compileCommand.directory
			)
		);

		this.preprocessUriMap.set(srcUri.path, preprocessUri);
		this.compileCommands.set(
			preprocessUri.path,
			new CompileInfo(
				preprocessUri,
				srcUri,
				compileCommand.getPreprocessCommand(preprocessUri.path),
				compileCommand.directory
			)
		);
	}

	private static execCompileCommand(compileInfo: CompileInfo) {
		const command = compileInfo.command.split(" ");
		const result = child_process.spawnSync(command[0], command.slice(1), {
			cwd: compileInfo.compilationDirectory,
			encoding: "utf8"
		});

		if (result.status) {
			const error = result.error
				? result.error.message
				: result.output
				? result.output.join("\n")
				: "";

			window.showErrorMessage(
				"Cannot compile " + compileInfo.srcUri.path
			);

			this.errorChannel.clear();
			this.errorChannel.appendLine(compileInfo.command);
			this.errorChannel.appendLine(error);
			this.errorChannel.appendLine(
				command[0] +
					" returned with error code " +
					result.status.valueOf()
			);
			this.errorChannel.show();

			return false;
		}

		this.updateCompileInfo(compileInfo);

		return true;
	}

	private static needCompilation(compileInfo: CompileInfo) {
		const srcUri = compileInfo.srcUri;
		const compileTimestamp = this.compileTimestamps.get(srcUri.path);
		const stat = fs.statSync(srcUri.path);

		return (
			compileInfo.extraArgsChanged(this.extraArgs) ||
			!compileTimestamp ||
			stat.mtime > compileTimestamp
		);
	}

	private static updateCompileInfo(compileInfo: CompileInfo) {
		this.compileTimestamps.set(compileInfo.srcUri.path, new Date());
		compileInfo.extraArgs = this.extraArgs;
	}

	private static getCompileInfo(uri: Uri): CompileInfo | undefined {
		return this.compileCommands.get(uri.path);
	}

	private static parseCompileCommands(compileCommandsFile: string) {
		let filecontents = fs.readFileSync(compileCommandsFile);
		let jsonConvert = new JsonConvert(
			OperationMode.ENABLE,
			ValueCheckingMode.DISALLOW_NULL,
			true
		);
		let compileCommandsObj = JSON.parse(filecontents.toString());

		return jsonConvert.deserializeArray(
			compileCommandsObj,
			CompileCommand
		) as CompileCommand[];
	}

	private static getCompileCommandsPath() {
		const compileCommandsPath =
			workspace
				.getConfiguration("compilerexplorer")
				.get<string>("compilationDirectory") + "/compile_commands.json";

		return compileCommandsPath
			? resolvePath(compileCommandsPath)
			: resolvePath("${workspaceFolder}/compile_commands.json");
	}

	private static createOutputDirectory() {
		if (!fs.existsSync(this.outDir)) {
			fs.mkdirSync(this.outDir);
		}
	}

	private static getUriForScheme(srcUri: Uri, scheme: string) {
		const ext = (function() {
			switch (scheme) {
				case "disassembly":
					return ".s";

				case "llvm":
					return ".ll";

				default:
					return (
						".E" +
						srcUri.path.slice(
							srcUri.path.lastIndexOf("."),
							srcUri.path.length
						)
					);
			}
		})();

		const relativePath = Path.relative(workspace.rootPath!, srcUri.path);
		const dstUri = srcUri.with({
			scheme: scheme,
			path: this.outDir + relativePath.replace(/\//g, "@@") + ext
		});

		// Create Output directory if not present
		this.createOutputDirectory();

		return dstUri;
	}

	private static encodeAsmUri(uri: Uri): Uri {
		return this.getUriForScheme(uri, "disassembly");
	}

	private static encodeLLVMUri(uri: Uri): Uri {
		return this.getUriForScheme(uri, "llvm");
	}

	private static encodePreprocessUri(uri: Uri): Uri {
		return this.getUriForScheme(uri, uri.scheme);
	}
}

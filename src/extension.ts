"use strict";

import {
	workspace,
	window,
	commands,
	ExtensionContext,
	TextEditor
} from "vscode";
import { AsmProvider } from "./provider";
import { AsmDecorator } from "./decorator";
import { CompileCommands } from "./compile_commands";

export function activate(context: ExtensionContext) {
	const provider = new AsmProvider();

	// register content provider for scheme `disassembly`
	const providerRegistration = workspace.registerTextDocumentContentProvider(
		AsmProvider.scheme,
		provider
	);

	// Output channel to send compilation errors
	const errorChannel = window.createOutputChannel("C++ Compiler Explorer");

	if (!CompileCommands.init(errorChannel)) {
		window.showErrorMessage(
			"Cannot find compilation database. Update `compilerexplorer.compilationDirectory`."
		);
	}

	function openAsmDocumentForEditor(srcEditor: TextEditor) {
		let asmUri = CompileCommands.getAsmUri(srcEditor.document.uri);

		if (asmUri) {
			workspace.openTextDocument(asmUri).then(doc => {
				window
					.showTextDocument(doc, srcEditor.viewColumn! + 1, true)
					.then(asmEditor => {
						const decorator = new AsmDecorator(
							srcEditor,
							asmEditor,
							provider
						);
						// dirty way to get decorations work after showing disassembly
						setTimeout(
							_ => decorator.updateSelection(srcEditor),
							500
						);
					});
			});

			provider.notifyCompileArgsChange(asmUri);
		} else {
			window.showErrorMessage(
				srcEditor.document.uri +
					" is not found in compile_commands.json"
			);
		}
	}

	// register command that crafts an uri with the `disassembly` scheme,
	// open the dynamic document, and shows it in the next editor
	const disassCommand = commands.registerTextEditorCommand(
		"compilerexplorer.disassOutput",
		srcEditor => {
			openAsmDocumentForEditor(srcEditor);
		}
	);

	const disassWithArgsCommand = commands.registerTextEditorCommand(
		"compilerexplorer.disassOutputWithExtraArgs",
		srcEditor => {
			window
				.showInputBox({
					value: CompileCommands.getExtraCompileArgs()
				})
				.then(extraArgs => {
					if (extraArgs) {
						CompileCommands.setExtraCompileArgs(
							extraArgs.split(" ")
						);
					}

					openAsmDocumentForEditor(srcEditor);
				});
		}
	);

	context.subscriptions.push(
		provider,
		disassCommand,
		disassWithArgsCommand,
		providerRegistration,
		errorChannel
	);
}

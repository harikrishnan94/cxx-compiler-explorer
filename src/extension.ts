'use strict';

import { workspace, window, commands, ExtensionContext, TextEditor, TextDocument } from 'vscode';
import { AsmProvider } from './provider';
import { AsmDecorator } from './decorator';
import { CompilationDatabase, constructCompileCommand, getAsmUri, getOutputChannel } from './compdb';

export function activate(context: ExtensionContext): void {
    const provider = new AsmProvider();

    // register content provider for scheme `disassembly`
    const providerRegistration =
        workspace.registerTextDocumentContentProvider(AsmProvider.scheme, provider);

    const showDisassembly = async (srcEditor: TextEditor, customCommand: string[] = []) => {
        try {
            const asmUri = getAsmUri(srcEditor.document.uri);

            await provider.loadCompilationInfo(srcEditor.document.uri, asmUri, customCommand);

            const options = {
                viewColumn: srcEditor.viewColumn! + 1,
                preserveFocus: true,
            };

            const asmEditor = await window.showTextDocument(asmUri, options);
            const decorator = new AsmDecorator(srcEditor, asmEditor, provider);
            // dirty way to get decorations work after showing disassembly
            setTimeout(() => decorator.updateSelection(srcEditor), 500);

            workspace.onDidCloseTextDocument((d: TextDocument) => {
                if (d.uri == srcEditor.document.uri) provider.unload(d.uri);
            });
        } catch (error) {
            if (error instanceof Error)
                window.showErrorMessage(`Failed to show assembly: ${error.message}`);
            else
                window.showErrorMessage(`Failed to show assembly: ${JSON.stringify(error)}`);
        }
    }

    // register command that crafts an uri with the `disassembly` scheme,
    // open the dynamic document, and shows it in the next editor
    const disassembleCommand = commands.registerTextEditorCommand('compilerexplorer.disassOutput',
        async srcEditor => {
            await showDisassembly(srcEditor);
        });
    const disassembleWithArgsCommand = commands.registerTextEditorCommand('compilerexplorer.disassOutputWithCustomCommand',
        async srcEditor => {
            const ccommand = (await CompilationDatabase.for(srcEditor.document.uri)).get(srcEditor.document.uri);
            const command = await window.showInputBox(
                {
                    prompt: "Provide arguments to pass to compiler",
                    value: ccommand?.arguments.join(" ")
                });
            await showDisassembly(srcEditor, constructCompileCommand(command ? command : "", []));
        });

    context.subscriptions.push(
        provider,
        disassembleCommand,
        disassembleWithArgsCommand,
        providerRegistration,
        getOutputChannel(),
        CompilationDatabase.disposable()
    );
}

'use strict';

import { workspace, window, commands, ExtensionContext, TextEditor } from 'vscode';
import { AsmProvider } from './provider';
import { AsmDecorator } from './decorator';
import { getAsmUri, getOutputChannel } from './compdb';

export function activate(context: ExtensionContext): void {
    const provider = new AsmProvider();

    // register content provider for scheme `disassembly`
    const providerRegistration =
        workspace.registerTextDocumentContentProvider(AsmProvider.scheme, provider);

    const showDisassembly = (srcEditor: TextEditor, extraArgs: string[] = []) => {
        const asmUri = getAsmUri(srcEditor.document, extraArgs);

        const options = {
            viewColumn: srcEditor.viewColumn! + 1,
            preserveFocus: true,
        };

        window.showTextDocument(asmUri, options).then(asmEditor => {
            const decorator = new AsmDecorator(srcEditor, asmEditor, provider);
            // dirty way to get decorations work after showing disassembly
            setTimeout(() => decorator.updateSelection(srcEditor), 500);
        });
    }

    // register command that crafts an uri with the `disassembly` scheme,
    // open the dynamic document, and shows it in the next editor
    const disassembleCommand = commands.registerTextEditorCommand('compilerexplorer.disassOutput',
        srcEditor => {
            showDisassembly(srcEditor);
        });
    const disassembleWithArgsCommand = commands.registerTextEditorCommand('compilerexplorer.disassOutputWithExtraArgs',
        async srcEditor => {
            const extraArgs = await window.showInputBox({ prompt: "Add extra args to pass to compiler" });
            showDisassembly(srcEditor, extraArgs ? extraArgs.split(/(\s+)/) : []);
        });

    context.subscriptions.push(
        provider,
        disassembleCommand,
        disassembleWithArgsCommand,
        providerRegistration,
        getOutputChannel()
    );
}

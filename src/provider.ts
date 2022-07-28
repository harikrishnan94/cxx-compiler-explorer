'use strict';

import { Uri, EventEmitter, TextDocumentContentProvider, Event } from 'vscode';
import { AsmDocument } from './document';

export class AsmProvider implements TextDocumentContentProvider {

    static scheme = 'disassembly';

    private _documents = new Map<string, AsmDocument>();
    private _onDidChange = new EventEmitter<Uri>();

    provideTextDocumentContent(uri: Uri): string | Thenable<string> {
        const document = this.provideAsmDocument(uri);
        return document.value;
    }

    provideAsmDocument(uri: Uri): AsmDocument {
        let document = this._documents.get(uri.path);

        if (!document) {
            document = new AsmDocument(uri, this._onDidChange);
            this._documents.set(uri.path, document);
        }

        return document;
    }

    // Expose an event to signal changes of _virtual_ documents
    // to the editor
    get onDidChange(): Event<Uri> {
        return this._onDidChange.event;
    }

    dispose(): void {
        this._documents.clear();
        this._onDidChange.dispose();
    }

}

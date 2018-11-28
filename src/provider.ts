"use strict";

import {
	workspace,
	Uri,
	FileSystemWatcher,
	EventEmitter,
	TextDocumentContentProvider
} from "vscode";
import { AsmDocument } from "./document";
import { CompileCommands } from "./compile_commands";

export class AsmProvider implements TextDocumentContentProvider {
	static scheme = "disassembly";

	private _documents = new Map<string, AsmDocument>();
	private _watchers = new Map<string, FileSystemWatcher>();
	private _onDidChange = new EventEmitter<Uri>();

	provideTextDocumentContent(uri: Uri): string | Thenable<string> {
		let document = this.provideAsmDocument(uri);
		return document.value;
	}

	provideAsmDocument(uri: Uri): AsmDocument {
		// already loaded?
		let document = this._documents.get(uri.toString());

		if (document) {
			return document;
		}

		document = new AsmDocument(uri);
		this._documents.set(uri.toString(), document);

		// Watch for src file and reload it on change
		this.addWatcherForSrcURI(uri);

		return document;
	}

	private addWatcherForSrcURI(uri: Uri) {
		const watcher = workspace.createFileSystemWatcher(
			CompileCommands.getSrcUri(uri)!.path
		);

		watcher.onDidChange(fileUri =>
			this.reloadAsmDocument(CompileCommands.getAsmUri(fileUri)!)
		);
		watcher.onDidCreate(fileUri =>
			this.reloadAsmDocument(CompileCommands.getAsmUri(fileUri)!)
		);
		watcher.onDidDelete(fileUri =>
			this.reloadAsmDocument(CompileCommands.getAsmUri(fileUri)!)
		);
		this._watchers.set(uri.toString(), watcher);
	}

	reloadAsmDocument(fileUri: Uri) {
		const uri = fileUri.with({ scheme: AsmProvider.scheme });
		const document = new AsmDocument(uri);

		this._documents.set(uri.toString(), document);
		this._onDidChange.fire(uri);
	}

	// Expose an event to signal changes of _virtual_ documents
	// to the editor
	get onDidChange() {
		return this._onDidChange.event;
	}

	dispose() {
		this._watchers.forEach(watcher => watcher.dispose());
		this._documents.clear();
		this._onDidChange.dispose();
	}
}

# cxx-compiler-explorer README

Shows disassembly to source relations and dims unused source lines.

This extension is based on Compiler Explorer (especially AsmParser class from it) and https://github.com/dseight/vscode-disasexpl (provider.ts and decorator.ts).

## Usage

Run `compilerexplorer.disassOutput` from Command palette.
Disassembly will be shown in a new column.

Run `compilerexplorer.disassOutputWithExtraArgs` from Command palette to use add extra compile options.

## Requirements

`compilerexplorer.compilationDirectory` must point to location of build directory containing compile commands.

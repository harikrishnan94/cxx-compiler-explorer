# cxx-compiler-explorer

Shows disassembly to source relations and dims unused source lines.

This extension is based on https://github.com/dseight/vscode-disasexpl (which is originally based on parts from Compiler Explorer code).

## Usage

Run `compilerexplorer.disassOutput` from Command palette.
Disassembly will be shown in a new column.

Run `compilerexplorer.disassOutputWithCustomCommand` from Command palette to use edit compile command.

## Requirements

`compilerexplorer.compilationDirectory` must point to location of build directory containing compile commands.

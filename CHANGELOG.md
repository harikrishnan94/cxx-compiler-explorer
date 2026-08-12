# Change Log

## v0.8.0

### Features
* Pick up compile commands from the Microsoft CMake Tools extension when compile_commands.json is missing, so CMake users no longer need to export it by hand, by @sr-tream in #51
* Add a compilerexplorer.intelSyntax setting to emit Intel syntax assembly, off by default, by @Stovent in #61

### Fixes
* Fix path handling on Windows, covering drive letter case and separator mismatches between compile_commands.json and VS Code URIs (#34), by @Stovent in #62
* Correctly handle invalid file paths, so one unresolvable relative path no longer causes the whole compilation database to be ignored, by @dprogm in #53

Thanks to @sr-tream, @Stovent and @dprogm for the contributions in this release.

## v0.7.1
* Make use of the 'directory' property as specified in the JSON compilation database format specification by @dprogm in #36

## v0.7.0
* Unload document once the source editor is closed by @harikrishnan94 in #28
* Update changelog by @harikrishnan94 in #29
* Allow editing of compilation command before generating assembly by @harikrishnan94 in #30
* Fixes for reliability and compilation cancellation by @appden in #31

## v0.5.2
* Add icon by @harikrishnan94 in https://github.com/harikrishnan94/cxx-compiler-explorer/pull/22
* Show compilation progress by @harikrishnan94 in https://github.com/harikrishnan94/cxx-compiler-explorer/pull/24
* Better error handling by @harikrishnan94 in https://github.com/harikrishnan94/cxx-compiler-explorer/pull/26
* Watch Errored files too by @harikrishnan94 in https://github.com/harikrishnan94/cxx-compiler-explorer/pull/27
* Unload document once the source editor is closed by @harikrishnan94 in https://github.com/harikrishnan94/cxx-compiler-explorer/pull/28

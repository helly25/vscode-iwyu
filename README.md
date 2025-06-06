# Include What You Use

This extension integrates [include-what-you-use](https://github.com/include-what-you-use/include-what-you-use) or short
`IWYU` in `VScode` (see quote below). The `IWYU` tool is invoked in the background to provide analytics and can be invoked manually to fix actual include use. The extension further allows to check for the presence and correctness of [include guards](https://en.wikipedia.org/wiki/Include_guard).

> QUOTE: "Include what you use" means this: for every symbol (type, function, variable, or macro) that you use in foo.cc
 (or foo.cpp), either foo.cc or foo.h should include a .h file that exports the declaration of that symbol. (Similarly,
 for foo_test.cc, either foo_test.cc or foo.h should do the including.) Obviously symbols defined in foo.cc itself are
 excluded from this requirement." \[[IWYU](https://github.com/include-what-you-use/include-what-you-use/blob/master/README.md)\]

## Features

1) The extension automatically detects unused includes and provides diagnostic squiggles which come with a quickfix that invokes IWYU.

![IWYU](https://helly25.com/wp-content/uploads/2023/05/iwyu-animated.gif)

2) Manually optimize the include files for the current C/C++ file by pressing `cmd-shift-P` + `I` + `W` + `Y` + `U` for command "`Include What You Use (current file)`". The extension will then lookup the current editor's file in the compile_commands.json file. If found it will then run the include-what-you-use tool. If that is successful it will then call the fix_includes.py script to apply the changes.

![IWYU](https://helly25.com/wp-content/uploads/2023/05/iwyu.png)

3) Manually optimize all project files using command "`Include What You Use (all targets)`". This is a slow operation as it goes over all files in the `compile_commands.json` one after the other. It only triggers on source files whose first directory (or the file itself if directly in the project workspace root) is not a symbolic link (which for instance excludes `external` or `bazel-out`). The settings `iwyu.fix.ignore_re` and `iwyu.fix.only_re` are respected upfront and prevent unnecessary triggering.

4) The extension will check headers for presence and correctness of include guards. Include guards will only be searched for in files matching `iwyu.diagnostics.include_guard_files`. In those files the guards are derived from
the `iwyu.diagnostics.include_guard` setting. The value `${file}` will be replaced with the filename as is and `${FILE}` will be replaced with the filename in all upper case. All other chars are used as is. So the value  `${FILE}_` adds a '_' to the relative filename in all upper case (for instance `path/foo.h` becomes `PATH_FOO_H_`).
>
> NOTE: The default for the `iwyu.diagnostics.include_guard` setting is empty which disables this feature.

Additional information beyond this REDME can be found at [helly25.com/vscode-iwyu](https://helly25.com/vscode-iwyu).

## Requirements

This extension assumes C++ development using a toolchain that produces a `compile_commands.json` database that
covers all C++ files. When building with bazel using clang this can be autogenerated using
[hedronvision/bazel-compile-commands-extractor](https://github.com/hedronvision/bazel-compile-commands-extractor).

### include-what-you-use

Install [include-what-you-use](https://include-what-you-use.org/). For example on Mac:

```sh
brew install include-what-you-use
```

## Alternatives

* This extension is a wrapper around the `include what you use` tool and similar to [pokowaka-iwyu](https://marketplace.visualstudio.com/items?itemName=pokowaka.pokowaka-iwyu). The reason for this extension is its debug and
filter capability, it's ability to provide analytics with squiggles and of course the include guard checks. None of those features are available in `pokowaka-iwyu`.

* `Clang` has an extra tool [clang-include-fixer](https://clang.llvm.org/extra/clang-include-fixer.html). However, the clang toolchain is less sophisticated in its cleanup ability and requires a much more complex setup process that is not
easily achievable with all projects. The standard clang configurations also have limited include guard analysis compared to this extension.

## Extension Settings

This extension has the following general settings:

- `iwyu.compile_commands` Path to `compile_commands.json` file (supports `${workspaceFolder}`,
  `${workspaceRoot}` and `${fileWorkspaceFolder}`). If set to the default `auto`, then the extension will try:
  - `${workspaceFolder}/compile_commands.json`,
  - `${workspaceFolder}/build/compile_commands.json`,
  - `${fileWorkspaceFolder}/compile_commands.json`, and
  - `${fileWorkspaceFolder}/build/compile_commands.json`.
- `iwyu.filter_iwu_output`: Regexp expression filter for iwyu output. This will be used as {here} in
  '#include.*({here})'. For instance in order to not add system includes under '__fwd/*.', set this to '<__fwd/'. This
  does not result in removing such headers, it merely prevents adding them, so it won't produce diagnostics for such includes.
- `iwyu.fix_includes.py`: Path to the `fix_includes.py` script (finds the script on path if empty).
- `iwyu.include-what-you-use`: Path to the `include-what-you-use` executable (finds the executable on path if empty).

The diagnostics can be further configured:

- `iwyu.diagnostics.full_line_squiggles`: Whether to underline the whole line with squiggles or only the actual include part. The error is technically only on the actual include (from `#` to eiter `>` or second `"`) but tools commonly underline the whole line and the fix script will also remove the whole line.
- `iwyu.diagnostics.include_guard_files`: Regular expression for files that should be checked for include guards.
- `iwyu.diagnostics.include_guard`: If this is non empty, then include guards are checked. The relative filename is denoted as '${file}' (as-is) or '${FILE}' (uppercase), so in order to require all caps include guards that end in a '_' this must be set to '${FILE}_' (e.g. 'path/foo.h' then becomes 'PATH_FOO_H_').
- `iwyu.diagnostics.iwyu_interval`: Minimum interval time in seconds between iwyu calls.
- `iwyu.diagnostics.only_re`: Only compute diagnostics for files that match this regexp.
- `iwyu.diagnostics.scan_min`: Scan at least this many lines, if no include is found, then stop.
- `iwyu.diagnostics.scan_more`: After finding an include, scan at least this many more lines.
- `iwyu.diagnostics.unused_includes`: Enables diagnostic squigglies for unused includes.

The `include-what-you-use` tool can be configured with the following settings (names and description taken from flags):

- `iwyu.iwyu.additional_params`: Additional parameters you wish to pass to iwyu (must be prefixed with `-Xiwyu` in order to affect iwyu, otherwise will affect the compiler).
- `iwyu.iwyu.keep`: A glob that tells iwyu to always keep these includes. Can be provided multiple times.
- `iwyu.iwyu.mapping_file`: Mapping file to use. See
   [IWYU Mappings](https://github.com/include-what-you-use/include-what-you-use/blob/master/docs/IWYUMappings.md) for
   details.
- `iwyu.iwyu.max_line_length`: Maximum line length for includes.Note that this only affects comments and alignment
   thereof, the maximum line length can still be exceeded with long file names
- `iwyu.iwyu.no_default_mappings`: Do not add iwyu's default mappings.
- `iwyu.iwyu.no_fwd_decls`: Do not use forward declarations.
- `iwyu.iwyu.transitive_includes_only`: Do not suggest that a file add foo.h unless foo.h is already visible in the
  file's transitive includes.

The `fix_includes.py` tool can be configered with the following settings (names and description taken from flags):

- `iwyu.fix.comments`: Put comments after the #include lines."
- `iwyu.fix.dry_run`" Do not actually edit any files; just print diffs. Return code is 0 if no changes are needed, else min(the number of files that would be modified, 100).
- `iwyu.fix.ignore_re`: Skip editing any file whose name matches this regular expression.
- `iwyu.fix.only_re`: Skip editing any file whose name does *NOT* match this regular expression.
- `iwyu.fix.reorder`: Re-order lines relative to other similar lines (e.g. headers relative to other headers).
- `iwyu.fix.safe_headers`: Do not remove unused #includes/fwd-declares from header files; just add new ones.
- `iwyu.fix.update_comments`: Replace *why* comments with the ones provided by IWYU.
- `iwyu.fix.fix_header`: Fix includes in the corresponding header for a given implementation file (e.g. foo.h when fixing foo.cpp).

Note that settings `iwyu.fix.ignore_re` and `iwyu.fix.only_re` are also used to determine whether execution can be skipped.

### How to Debug and Correct IWYU Mistakes

The IWYU tool can be debugged using its output log which supports the `Developer: Set Log Level` setting. Once set to `Trace`, the `IWYU` output window shows the detailed command lines used and the output of the tool prior to sending it to the `fix_include.py` script.

#### Simple IWYU output filtering

If the tool geneally tries to add includes that should not be added, then these can be excluded using the
`iwyu.filter_iwyu_output` setting or mapping files (see below).

The following (`settings.json`) example suppresses adding system includes for `__fwd/*`.

```JSON
{
    "iwyu.filter_iwu_output": "<__fwd/"
}
```

The specified value is a reular expression that will be appended to `#include.*`. In the example this will create the
regular expression `#include.*<_fwd/`. When the iwyu tool runs, all lines matching that reular expression will be
filtered out. So when IWYU suggests to add `#include <__fwd/string_view.h>               // for string_view`, then that
line will simply be dropped.

#### In source control using comments

Taken from
[IWYU](https://github.com/include-what-you-use/include-what-you-use/blob/master/README.md#how-to-correct-iwyu-mistakes):

* If fix_includes.py has removed an `#include` you actually need, add it back in with the comment
  '`// IWYU pragma: keep`' at the end of the #include line. Note that the comment is case-sensitive.
* If fix_includes.py has added an `#include` you don't need, just take it out. We hope to come up with a more permanent
  way of fixing later.
* If fix_includes.py has wrongly added or removed a forward-declare, just fix it up manually.
* If fix_includes.py has suggested a private header file (such as `<bits/stl_vector.h>`) instead of the proper public
  header file (`<vector>`), you can fix this by inserting a specially crafted comment near top of the private file
  (assuming you can write to it): '`// IWYU pragma: private, include "the/public/file.h"`'.

#### Using a mapping file

The `fix_include.py` also supports a
[mapping file](https://github.com/include-what-you-use/include-what-you-use/blob/master/docs/IWYUMappings.md) that
allows to specify multiple mappings from private to public headers.

## Known Issues

* The extension has only been tested on Linux/Mac. In particular the extension does not understand Windows line endings.

* If the extension is used with clangd, then When the first C++ files gets active or when the `compile_commands.json` file changes, then IWYU triggers which in turn triggers clangd indexing. That might take a while depending on the computer and source repository. The indexing progress is shown in the status bar.

* The extension does not support include guards that have aribtrary extensions. Instead the include guards must follow
a strict pattern that can be configured in `settings.json` per project or globally in the user's settings.

# Change Log

## [0.0.1]

- Initial release

## [0.0.2]

- Fix image link

## [0.0.3]

- Add diagnostic support
- Add quickfix support

## [0.0.4]

- Speed up diagnostics by limiting how often iwyu is run and apply heuristics to early skip source scanning.
- Add new config settings:
    - `iwyu.diagnostics.iwyu_interval`: Minimum interval time in seconds between iwyu calls.
    - `iwyu.diagnostics.only_re`: Only compute diagnostics for files that match this regexp.
    - `iwyu.diagnostics.scan_min`: Scan at least this many lines, if no include is found, then stop.
    - `iwyu.diagnostics.scan_more`: After finding an include, scan at least this many more lines.

# [0.0.5]

- Per file IWYU data handling.
- Improved header processing:
    - Rename `iwyu.fix.safe` to `iwyu.fix.safe_headers` to match the actual argument name.
    - Change `iwyu.fix.safe_headers` to default to false, so that the tool works for headers by default.
    - Provide `--basedir` to `fix_includes.py` invocation to explicitly apply fixes only to the selected file.
    - Change `iwyu.fix.comments` to default to false.
    - Add `iwyu.fix.dry_run` config for additional debugging.
    - Add `iwyu.fix.update_comments` to go along with `iwyu.fix.comments`.

# [0.0.6]

Added new config settings:
-  `iwyu.diagnostics.full_line_squiggles`: Whether to underline the whole line with squiggles or only the actual include part. The error is technically only on the actual include (from `#` to eiter `>` or second `"`) but tools commonly underline the whole line and the fix script will also remove the whole line.
- Use LogOutputChannel instead of OutputChannel for better log output control.
- Also remove setting `iwyu.debug`.

# [0.0.7]

Add new command `Include What You Use (all targets)`. See README.md for details.

# [0.0.8]

Fix settings default for `iwyu.iwyu.keep`.
Change default for `iwyu.diagnostics.iwyu_interval` to 5 (seconds).

# [0.0.9]

Add support for include guard detection and correction.
Add new settings:
. `iwyu.diagnostics.include_guard_files`: `Regular expression for files that should be checked for include guards."
. `iwyu.diagnostics.include_guard`: If this is non empty, then include guards are checked. The relative filename is denoted as '${file}' (as-is) or '${FILE}' (uppercase) , so in order to require include guards that end in a '_ thi must be set to '${file}_'.

# [0.0.10]

Disable include guard checks by default. Seeting `iwyu.diagnostics.include_guard` to ".

# [0.0.11]

Only check `iwyu.diagnostics.include_guard` once per file.
Fix lookup of setting `iwyu.diagnostics.include_guard`.
Provide a direct link for diagnostics to the documentation.

# [0.0.12]

Update README.md.

# [0.0.13]

Bad release

# [0.0.14]

Fix include guard trigger.
Refactor most extension code to use class Extension.
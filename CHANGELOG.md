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
-  `iwyu.diagnostics.full_line_squiggles`: Whether to underline the whole line with squiggles or only the actual include part.

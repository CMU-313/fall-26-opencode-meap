
- [Export Stats](#export-stats)

---

## Export Stats

### Usage

To use the export feature of the stats cli command, pass the --export flag along with one of the three supported formats "json", "csv", and "md"

The stats file will be written to the opencode directory titled opencode_stats_<timestamp>.<format>

Stats files are written with the timestamp to prevent collisions upon subsequent stats --export invocations without clearing directory.

### Testing 

Full test suite for --export functionality is located here:
packages/opencode/test/cli/stats-export.test.ts

The initial 10 tests from sprint 1 covered output invariance across export formats.

The 12 sprint 2 tests covered specific edge cases and failure modes of the specific export formats:
- null values are never written to file output
- 0 in date range in stats objects writes empty datestring instead of zero epoch
- model containing | in name does not break .md table
- negative flag params do not affect output written to file
- exportPath returns correct joined string
- export methods write file of correct specified format
- writeExport reports written file path via stderr msg
- writeExport to unwriteable path throws err
- reportStats defaults to cli output and control flow for export formats is correct

These tests help to validate the initially outlined success criteria involving stats records being updated upon use and export functionality being successful across json and csv formats, with the addition of markdown format.

---

- [Persistent memory](#persistent-memory)

---

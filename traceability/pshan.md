ID
Interview evidence
Requirement
Acceptance criteria

R1
C-12, S-11: “Probably averages, because sequencing gives you a lot of extra information that I probably don’t care about.” 
Aggregate stats do not depend on the order in which messages were sent or models were used. 
Two test usage histories contain the same messages (model A, then model B, versus model B, then model A). Exporting each with --export json gives identical totals, averages, and per-model rows. 

R2
C-17
“It should be [a] carbon copy of what’s actually in whatever opencode’s data [is].”  
For the same flags, file exports contain every field the stats CLI prints, with identical values
The user runs the export stats command in all three formats, the parsed contents of each exported file should always match the cli output to the last 3 decimal places on numbers (since some stats with decimal values may get rounded to 4 decimal places)

R3
S-8, C-8, O-6: “If there’s some minor differences like that in the precision, it doesn’t matter.” 
The CSV export writes numbers in plain decimal form, never scientific notation. Token counts are exact integers. Average usage and cost numbers can be rounded to avoid changes from opening in Excel. Revised: average usage and cost numbers are rounded to 4 decimal places, precise enough to match the CLI to 3 places (R2).
The export command is run with the –format csv flag, the output should never contain values with more than 4 decimal places to prevent conversion into scientific notation or truncation if the user opens the file with an editor like excel.

R4 (to be added)
S-4, S-5, S-10: 
 “Yeah, like I said, I worry about when you put it in the root, it would get pretty cluttered. I would say maybe if it could have its own folder and then I can close [clear?] it easy, I think that would be good.”
Exports are written to a dedicated stats subfolder, not the opencode root directory. 
The user runs the export command after a session, the stats reports are written to a dedicated stats directory of the opencode app, which can be changed to a different directory on the user’s PC in settings

R5 (to be added)
S-9, C-9, C-11, O-7, O-9: “There should be an option and the default being replacing it is probably fine.” 
By default, re-exporting in the same format overwrites the previous file. A –new flag keeps old reports and writes a new file that includes the timestamp instead. 
The user runs the export command, by default the the new stats summary overwrites the old one, since the summary statistics encompass usage from the start of each time interval, if the –new flag is passed with the export stats command, a new stats report is written to the stats export directory, with the timestamp in the filename, so the latest one is easy to find.

Requirement Changes:

All of the user requirements are feasible to implement. Requirements 1-3 are already partially implemented as the underlying logic, so they just need to be reviewed to verify they align precisely with the requirements. R3 was revised from the original: it only allowed average and cost numbers to be rounded, and now fixes them at 4 decimal places, because rounding averages to 2 places broke R2's 3-decimal match with the CLI. R5 was also changed from the original: instead of overwriting by default with a --new flag to keep old reports, every export now writes a new timestamped file by default so earlier reports are never lost, and an --overwrite flag replaces a single fixed file (opencode_stats.<format>) for users who only want the latest summary. Requirements 4 and 5 involve adding two new cli flags to specify default export path and idempotency. They could be implemented via two optional flags: --out, --overwrite
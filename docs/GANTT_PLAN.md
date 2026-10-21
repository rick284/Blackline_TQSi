# Programme and Gantt: plan

Rick's brief (2026-10-21): **Programme** and **Gantt** are two separate windows. The Gantt is Blackline's own version of MS Project: it has to produce a file MS Project can open, and match MS Project's functions, tools, options and feel as closely as practical.

## What each window is

| | Programme | Gantt |
|---|---|---|
| Purpose | The *tender* programme: one task per QS item, durations worked out from the estimate's resource rows, preliminaries as a hammock, critical path, the 55-working-day baseline that the weather allowance and time-related costs rest on. | A full planning tool: any tasks, any links, calendars, constraints, baselines, progress, resources. |
| Data | Existing records `programme:config`, `task:*` in package "Programme and Schedule". Engine: `tender/src/programme.ts` (finish-to-start, whole working days). Unchanged. | New package **Gantt**, records `gantt:config`, `gtask:*`, `gcal:*`, `gres:*`, `gasg:*`. Engine: `tender/src/gantt/`. |
| Link between them | "Send to Gantt" builds Gantt tasks from the tender programme (one per task, links kept, durations in days). The Gantt can be re-built from the programme at any time; it never changes the programme. | |

They are separate packages, so a planner can hold the Gantt while an estimator holds the Programme.

## The file MS Project opens

MS Project's own `.mpp` is a closed binary format; nothing outside Microsoft writes it reliably. The open format MS Project reads (File > Open) and writes (File > Save As > XML) is **MSPDI**, an XML schema Microsoft publishes. Blackline exports and imports MSPDI. In MS Project the person opens the `.xml` and can Save As `.mpp` if they want one. This was written to the published schema and its element order; it has **not** yet been opened in a copy of MS Project, so the first real test is Rick opening an exported file and telling us what MS Project says.

Exported: project properties and start, calendars (week days, working times, exceptions), tasks (outline, WBS, durations, start/finish, % complete, milestones, summaries, constraints, deadlines, notes, active flag, baseline 0), predecessor links (FS/SS/FF/SF with lag), resources and assignments. Imported: the same, by element name, so a file saved by MS Project loads too.

## The scheduling engine (`packages/tender/src/gantt`)

Pure TypeScript, no browser or Node APIs, so the browser and the server calculate identically.

- Time is whole minutes on a calendar. A task's duration is working minutes (shown as days/hours/weeks like MS Project, using the calendar's hours per day).
- **Calendars**: working days of the week with working times per day (default "Standard": Mon-Fri 8:00-12:00, 13:00-17:00), exceptions (public holidays, shutdowns, working Saturdays), task calendars.
- **Links**: FS, SS, FF, SF, with positive or negative lag.
- **Constraints**: As Soon As Possible, As Late As Possible, Must Start On, Must Finish On, Start No Earlier Than, Start No Later Than, Finish No Earlier Than, Finish No Later Than; deadlines.
- **Outline**: summary tasks roll up start, finish, duration, % complete from their children; indent/outdent; collapse.
- **Critical path**: forward and backward pass, total slack and free slack, critical = total slack <= 0; a negative slack means a constraint or deadline is missed.
- **Progress**: % complete, with the status date; baseline 0 (start, finish, duration) saved and compared.
- Problems are reported, never thrown: loops, links to missing tasks, a constraint that can't be met.

## The Gantt window (what it will do, in the order it is built)

**Stage 1 (this build)**
- Task table with MS Project's core columns (ID, Task Name, Duration, Start, Finish, Predecessors, % Complete, Resource Names), outline indent, collapse and expand, inline editing; a timeline with two-tier timescale, bars, summary brackets, milestone diamonds, link arrows, critical path in black, baseline marks, today line, non-working time shading.
- Toolbar groups named as MS Project names them: **File** (Export to MS Project, Import from MS Project, Build from the tender Programme), **Task** (Insert task / summary / milestone, Delete, Indent, Outdent, Move up/down, Link, Unlink, Mark on track 0/25/50/75/100%, Inactivate), **View** (Zoom in/out, timescale unit, Critical tasks, Baseline, Today, Scroll to task), **Project** (Project start, calendar, Set baseline, Clear baseline).
- Task Information as a docked panel (not a pop-up): name, duration, % complete, constraint and date, deadline, calendar, predecessors with type and lag, notes, active.
- Dragging a bar moves it (sets Start No Earlier Than); dragging its right edge changes the duration; dragging from a bar's end to another bar links them.
- Undo/redo, check out/check in, parked changes: the same package rules as every other window.

**Stage 2**
- Resource Sheet and assignments (work, units, cost), resource names in the table, resource usage; task types (fixed units/duration/work); effort-driven scheduling.
- Calendar editor (Change Working Time), Project Information (status date, schedule from finish).
- Columns chooser, sort/filter/group, more tables (Entry, Schedule, Variance, Cost), tracking Gantt (baseline bars), split tasks, task notes view, manual vs auto-scheduled, lead/lag in percent.
- Printing: PDF of the chart, copy picture.

**Stage 3**
- Linking the Gantt to the estimate: durations from Programme, cost loading from the estimate for cashflow, weather days from the Weather Risk module.
- Network diagram, timeline view, reports.

## Status (2026-10-22)

Built and tested: the scheduling engine (calendars, FS/SS/FF/SF with lag, all eight constraints, deadlines, summary roll-up, slack, critical path), MSPDI export and import, the Gantt package on the server (`POST /jobs/:id/gantt`), the Programme window, and Gantt Stage 1: ribbon (File, Task, View, Project), task table with inline editing and outline, timeline with bars / brackets / milestones / link arrows / baseline / today / non-working shading, drag to move, resize and link, Task Information docked beside the chart, build from the Programme, import and export, keyboard shortcuts (Insert, Delete, Alt+Shift+arrows, Ctrl+F2, Ctrl+Shift+F2), undo and redo.

**Not verified:** an exported file has not been opened in MS Project itself. It is well-formed, in Microsoft's namespace, in schema order, and reads back identically in Blackline, but only MS Project can say it is happy. Rick to try one and report anything it says.

**Stage 2 (2026-10-22), built and tested:**
- **Views** (View tab > Views): Gantt Chart, Resource Sheet, Calendars.
- **Resource Sheet**: add, edit and delete resources (Work / Material / Cost, initials, max units, standard rate); work, cost, task count, peak units and an Over-allocated flag per resource (peak units at once against max units); the tasks a selected resource is on. Resources go on tasks in the Resource Names column or in Task Information (`Digger, Labourer[50%]`; a name that isn't a resource becomes one). Work = duration x units, cost = work x rate (Work), units x rate (Material/Cost). Assignments don't change the schedule (fixed-duration tasks).
- **Calendars** (Change Working Time): working times per weekday, exceptions (holidays, shutdowns, working Saturdays), new calendar as a copy, rename, delete (not the project's or one a task uses), project calendar, hours per day / week. Changing a calendar reschedules the project.
- **Columns**: 26 MS Project columns (ID, WBS, Task Name, Duration, Start, Finish, Predecessors, % Complete, Resource Names, Work, Cost, slack, critical, constraint, deadline, late dates, baseline and variances, calendar, active, notes), chosen and ordered in a docked panel; adjustable divider between table and chart.
- **Sort**: click a heading (ascending, descending, off) or View > Sort by; sorts within each summary so the outline is kept; Sort by ID restores. **Filter**: All, Critical, Milestones, Summary, Incomplete, Completed, Late, Slipping, Inactive, Using Resource, Date Range, plus a text find; summaries stay above what matches.
- Columns, sort, filter, zoom and table width are the person's own view, kept on this computer per job (not in the plan).

Not built yet: tracking Gantt, split tasks, manual scheduling, effort-driven scheduling and task types, resource usage view and levelling, percentage lags, baselines 1-10, recurring calendar exceptions, group by, custom fields, printing, network diagram, timeline view, reports, linking cost loading to the estimate.

## Rules this module must keep

- No pop-ups: Task Information, the calendar editor and any questions are docked panels or bars in the page.
- Black, white and greys only. Critical = black bar, normal = mid grey, progress = darker inner bar, baseline = thin outline below the bar.
- All edits are drafts on a checked-out package, with undo/redo, like everything else.
- The engine is tested against hand-worked cases (calendars, each link type, each constraint) and the exporter against the MSPDI schema's required structure and element order.

# Mission dashboard prototype

Run `bun run dashboard` and open <http://127.0.0.1:4318>.

The read-only dashboard loads missions and goal records from the local Soma
home. Select a mission, filter by the canonical goal statuses, search goals,
or open a goal's record. Refresh reads the files again. The responsive layout
supports narrow screens and keyboard navigation, including Escape to close details.

`SOMA_HOME` selects another home; `SOMA_DASHBOARD_PORT` changes the port.
The server binds only to `127.0.0.1`, rejects cross-site requests and mutations,
and sends private responses with `Cache-Control: no-store`. No private sample
content is checked in and no browser storage is used. The only service read
is the local Vigil subjects API.

Mission cards summarize explicit linked goals. Missions have no independent
status field. Goal status is the recorded lifecycle state, not an estimate of
progress. “Reviews due” counts active goals whose review date is today or earlier
using the browser's local date. Sensor readings appear separately from lifecycle
status. This prototype does not load pursuit state, in-progress worker activity,
or goal-sweep recommendations.

## Sensor readings

For the default Soma home, the dashboard reads recorded goal observations from
`http://127.0.0.1:8767/api/vigil/subjects`. Set `SOMA_DASHBOARD_VIGIL_URL` to
another numeric loopback HTTP endpoint at `/api/vigil/subjects`, or set it to
an empty string to disconnect. A custom `SOMA_HOME` needs an explicit source;
it never silently mixes that profile with the default profile's observations.

Refresh reads both profile files and Vigil. It never executes a sensor,
publishes a ledger event, sends an alert or changes a goal. Requests time out
after three seconds, reject redirects, and cap responses at 2 MiB. Source errors
leave the profile visible with sensor readings explicitly unavailable.

The sensor column shows the latest recorded goal-level observation and time.
Readings and freshness labels are snapshots at fetch time; the page does not poll
or age labels in the background. Use Refresh, or reopen details, to update them.
Details also show the recorded run state, next expected observation and run ID.
The public API supplies state, not numeric item counts or activation identity:
the view cannot attest that a reading came from the goal's currently configured
activation. The configured sensor ID remains visible separately.

Only exact `state:goal:G<n>` and `run:job:goal-sense/G<n>` subjects with matching
run IDs and end times establish a measured result. An unrelated job or sweep
check cannot supply a goal reading. A newer failed, cancelled or blocked sensor
run takes precedence; an older state appears only as a historical reading.
A successful run without a matching state is explicitly unknown.

Freshness uses Vigil's reported expected time and observation time. “Next reading
overdue” starts after one cadence; stale starts strictly after twice that
cadence, or immediately when Vigil marks the observation stale. Unknown cadence
is labelled “Freshness unknown.” Vigil overwrites stale subjects' previous values,
so a stale row may have no original measured state to display. No configured
sensor, no recorded reading, disabled source and unavailable source stay distinct.
Timestamps are displayed in the browser's local timezone.

This is an isolated preview script, not a new core API or deployed service.
Private goal record bodies are fetched only when their details are opened and
rendered as plain text. Stop the terminal process to stop serving it.

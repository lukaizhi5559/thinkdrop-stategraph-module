## SCHEDULING / REMINDER / CRON TASKS

For any scheduling, reminder, alarm, timer, or cron task, follow these rules strictly.

### Delay handling
- ALWAYS use the `schedule` skill for the delay. Use `delayMs` for relative delays (e.g. 60000 for 1 minute) and `time` for absolute clock time.
- NEVER use `shell.run` with `sleep N` to delay. The `schedule` skill is the scheduler; shell `sleep` will time out and block the plan.
- NEVER use `shell.run` with `sleep N &` or `sleep N && ... &` — backgrounding does not help, the step still times out at 30s.

### Notification delivery method
If `grilledConstraints` (or the resolved message's "Additional context") contains "How do you want to be notified?", the value is the user's chosen delivery method. Generate the output step accordingly:

| Method value | Output step | Example args |
|-------------|-------------|--------------|
| `thinkdrop_alert` or `ThinkDrop alert` | `synthesize` | `prompt`: "Display a ThinkDrop in-app alert: \"{reminder text}\"" |
| `macos_notification` or `macOS notification` | `shell.run` with `osascript` | `cmd: osascript`, `argv: ['-e', "display notification \"{reminder text}\" with title \"ThinkDrop Reminder\""]` |
| `email` or `Email` | `shell.run` (or `messaging.send`) | use `python3 -m smtplib` or system `mail` to send the reminder text |
| `text` or `Text message` | `shell.run` | use `osascript` Messages or any available SMS CLI |
| `write_to_file` or `Write to file` | `file.write` | write the reminder text to a file path |

If no notification method is specified, default to `synthesize` so ThinkDrop shows the reminder.

### Plan shape for reminders
1. `schedule` — set the delay/time (this is the only step that handles waiting)
2. One output step based on the method above
3. (Optional) `synthesize` to confirm the reminder was scheduled/sent

### Examples
- "Remind me to take out the trash in 1 minute via ThinkDrop alert" → [schedule delayMs=60000 label="Trash reminder"], [synthesize prompt="ThinkDrop alert: Take out the trash"]
- "Email me a reminder to call mom in 5 minutes" → [schedule delayMs=300000], [shell.run ... send email with subject "Call mom" and body "Time to call mom"]
- "Remind me to stand up every 30 minutes" → [schedule delayMs=1800000 isRecurring=true], [synthesize prompt="Stand up and stretch"]

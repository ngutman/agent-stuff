# copy-last-response

Copies the last completed assistant response on the current branch to your clipboard as markdown.

## Trigger

- Shortcut: `Alt+O`
- Command: `/copy-last-response`

## Behavior

- Copies only assistant `text` blocks
- Preserves markdown formatting
- Ignores thinking and tool-call blocks
- Warns if the agent is still streaming or if no completed assistant response exists

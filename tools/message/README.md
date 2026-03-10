# Message Tool

Send messages to users through configured channels (currently Telegram only).

## Commands

### Send to Current Session

Send a message to the current session's channel/chat/thread:

```bash
/tools/bin/message --to-current-session -- Hello! This is a reply.
```

This only works when called from within an active LLM session. If called from a standalone script, you'll get an error and should use explicit targeting instead.

### Send to Specific Telegram Chat

Send to a specific chat (proactive messaging):

```bash
/tools/bin/message telegram 123456789 -- Hello! This is a proactive message.
```

Send to a specific thread in a Telegram forum:

```bash
/tools/bin/message telegram 123456789 42 -- Hello from the thread!
```

### With Formatting

Use `--parse-mode` for formatted messages (Markdown or HTML):

```bash
# Markdown
/tools/bin/message telegram 123456789 -- --parse-mode markdown -- **Bold** and _italic_ text

# HTML
/tools/bin/message telegram 123456789 -- --parse-mode html -- <b>Bold</b> and <i>italic</i> text
```

Note: Telegram uses MarkdownV2 syntax. See [Telegram's formatting docs](https://core.telegram.org/bots/api#markdownv2-style) for details.

## Error Handling

- **No session context**: When using `--to-current-session` from a script, you'll get an error with guidance to use explicit targeting.
- **Unsupported channel**: If the current session's channel doesn't support messaging (e.g., TUI), you'll get an error.
- **Channel not available**: If Telegram isn't enabled in the gateway config, explicit Telegram commands will fail.

## Long Messages

Messages longer than Telegram's 4096 character limit are automatically split into multiple messages.

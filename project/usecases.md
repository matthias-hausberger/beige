Needs:

#1 Travel Assistant:
- Needs to fetch sites, browse websites (browser automatino)
- Needs to have residential IP to not get blocked too much
- Needs to take screenshots
- Needs to write .md files, best to a shared folder (e.g. Google Drive) so I can open them with Obsidian

#2 Willhaben Automation:
- Needs to work with browser automation (js, residential IP)
- I need to log in MANUALLY so that the AI is already logged in when it starts. It should not know my credentials
- Needs to be auto-optimized (see efficiency and self-improvement section)

#3 CLI Tool Automation:
- Needs to use some CLI tools (e.g. slackCLI) that are available already to perform some actions (e.g. draft a message)
- Must NOT be able to directly have access to the CLI config (e.g. API Keys, OAuth credentials etc.)

#4 Programmer:
- Should be able to run full-on development environment to write code repos, run tests, run dev servers etc.
- Git commits, push etc. - again, without being able to sneak out 

#5 Multi-Agent collaborator:
- Should be able to spawn sub-agents or even other agents
- Needs to be governed by a gateway so we ensure concurrency limits

#6 Efficiency through writing code:
- Needs to be able to write some code that can call TOOLS that were provided to the AI, so that AI tool calling can become more efficient over time.

#7 Self-improvement and experimentation:
- Should be able to install stuff, try out things, play with tools, change local configs, but WITHOUT fucking up my laptop.

#8 Evil-safe:
- While we don't think anything happens, we should always prepare for the WORST, which is: exposing env vars, content, sensitive data



DO NOTS:
- No access to environment variables, even if it tried 
- No access to change "gateway config" to not give itself more permissions
- No access to browser credentials
- No access to specific CLI commands (e.g. "gh repo delete" or "slackcli send message")
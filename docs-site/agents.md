---
title: Agents
description: Connect an agent tool to your Drive, and what an agent key can and cannot do.
---

# Agents

## `drive init` connects what it finds

One command looks for {{AGENT_TOOLS}} on your machine. For each one it finds,
it connects the stock MCP filesystem server to your Drive folder using that
tool's own `mcp add` command. Nothing is installed beyond the server itself.

```sh
drive init
```

## Each tool gets its own folder

`drive init` mounts `~/Drive-agents/<tool>` for each tool on that tool's own
key. The MCP server and the tool's allowed folders point at that folder, not at
the folder you use, so the agent works through its own credential and your own
files are not in the way.

`drive agents revoke <tool>` unmounts that folder and revokes the key behind it.

Windows is not in version 1, and the agent mount is not proven there, so the
tool writes inside your own Drive. Linux and macOS get the folder.


```sh
drive agents
drive agents connect claude
drive agents revoke claude
```

## A branch an agent works in

Give an agent a copy of a folder so its work sits somewhere you can look at it
before it touches your files:

```sh
drive branch <folder>     # copy the folder into a branch
drive branches           # list the branches and how many files changed
drive diff <branch>       # the files added, changed or removed in it
drive approve <branch>    # copy the branch's changes back into the folder
drive discard <branch>    # throw the branch away; the folder is untouched
```

The agent works with its own branch key, made for the branch's one path under
`.branches/<name>/` in your account folder, and only you can approve the copy
back. [Branch keys](#branch-keys) says how far that key reaches.

Stop a tool with `drive agents revoke <tool>`, using the tool's own name
(`claude`, `codex`, `cursor`, `gemini` or `kiro`); the other tools stay
connected, because each one is connected on its own.

## What an agent key can do

An agent tool gets its own key, and the key is deliberately weaker than the key
your own machine has:

{{KEY_TABLE}}

An agent can create, change and rename anything in your Drive. {{AGENT_DELETE}}

## Branch keys

`drive branch <folder>` creates a server-side copy of that folder for an agent
to work in. The branch takes the folder's name, or `--name <n>`. The agent gets a
**branch key** made for the branch's own prefix:
`u/<your-id>/.branches/<branch-name>/`. It can read and write, and its deletes
follow the same rule as a regular agent key. {{BRANCH_REACH}}

Since a branch is a full copy, it counts against your storage until you
discard or approve it. Measured branch times for large folders are on the
Benchmarks page.

When you are done, `drive approve <branch>` copies the branch's changes back
to the original folder. If the original changed since you branched, `approve`
stops and lists the conflicting files. `drive discard <branch>` throws the
branch away; the original is untouched.

## Sessions and the folder

The filesystem server is scoped to the session's working directory, so an agent
sees your Drive when the session starts inside it. `drive init` leaves a note
in the folder telling the tool what the folder is, and writes the same thing
into each tool's own instructions file.

## Why it is built this way

A drive is a thing people use, and an agent that shares the same files should
not be able to quietly empty it. The table above is the rule, and it is the
same table the server enforces — a page cannot grant a power the code does not.
The [Security](/security) page says who else can reach the files.

## Next

- [Security](/security) — who can see your files, and who cannot.
- [Limits](/limits) — what is not in version 1.

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

To see what is connected, or to connect or disconnect one tool on its own:

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

The agent works with its own branch key: a branch key is scoped to the
branch's one path under `.branches/<name>/` in your account folder, so it can
list, read and write there and cannot remove anything — the same rule every
agent key follows. Your other files are outside its reach, and only you can
approve the copy back.

Stop a tool with `drive agents revoke <tool>`, using the tool's own name
(`claude`, `codex`, `cursor`, `gemini` or `kiro`); the other tools stay
connected, because each one is connected on its own.

## What an agent key can do

An agent tool gets its own key, and the key is deliberately weaker than the key
your own machine has:

{{KEY_TABLE}}

{{AGENT_CANNOT_DELETE}} An agent can create, change and rename anything in your
Drive; it cannot remove anything, so an agent that decides a file is finished
leaves it in place. Deleting needs a person.

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

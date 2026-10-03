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

## What an agent key can do

An agent tool gets its own key, and the key is deliberately weaker than the key
your own machine has:

{{KEY_TABLE}}

{{AGENT_CANNOT_DELETE}} An agent can create, change and rename anything in your
Drive; it cannot remove anything, so an agent that decides a file is finished
leaves it in place. Deleting needs a person.

## Branch keys

`drive branch <folder>` creates a server-side copy of that folder for an agent
to work in. The agent gets a **branch key** limited to the branch's own prefix:
`u/<your-id>/.branches/<branch-name>/`. It can read and write inside that
branch, but it cannot delete — the same rule as a regular agent key. A branch
key cannot reach your other files or other branches.

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

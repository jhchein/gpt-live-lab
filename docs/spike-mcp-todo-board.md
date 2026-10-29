# Spike: read-only MCP board tools

This branch lets the reasoning model read an operator's private to-do board through an MCP server. It is an experiment on `spike/mcp-todo-board`. We have not merged it, and we do not merge it without a separate decision by the repository owner.

## What it does

When `MCP_SERVER_URL` and `MCP_SERVER_TOKEN` are set, the backend lists the server's tools at the start of each delegation. It offers the allowlisted ones to the reasoning model as function tools, runs the calls itself and returns the results to the model. The token stays in the backend. GPT-Live gets one extra instruction, so it delegates questions about tasks, plans and blockers.

The client is [`server/mcp/client.ts`](../server/mcp/client.ts). It speaks Streamable HTTP, accepts JSON and event-stream replies, and adds no dependency. The tool loop and the trace redaction live in [`server/reasoning/delegation.ts`](../server/reasoning/delegation.ts).

## Run it

Set the values in the terminal that starts the backend, not in a file. The token is a bearer token for your own MCP server.

```powershell
$env:MCP_SERVER_URL = "http://127.0.0.1:8000/mcp"
$env:MCP_SERVER_TOKEN = $env:YOUR_BOARD_TOKEN
$env:MCP_SERVER_TOOLS = "tool_a,tool_b"
$env:REASONING_EFFORT = "medium"      # optional: low, medium or high
$env:REASONING_MAX_WORDS = "250"      # optional: 20 to 600, default 120
npm run dev
```

The tool list in `MCP_SERVER_TOOLS` is the control that matters. The first delegation writes `mcp.tools` to the raw events with the exposed names, or `mcp.unavailable` with the reason.

## What we learned

The server we tested declares no `readOnlyHint` on any tool, and one of its tools writes. The default rule, which exposes only hinted tools, therefore exposes nothing. We require an explicit allowlist and must never list a write tool.

A whole-plan snapshot tool returned more than 512 KB, and the first version of the client rejected it. We raised the response cap to 4 MB and still cut each result to 16,000 characters before it reaches the model. A cut snapshot helps the model little, so small targeted tools work better than a snapshot.

Answers came back short because the prompt capped them at 120 words. `REASONING_MAX_WORDS` now sets that limit. GPT-Live also did not know the board existed and had to be pushed to delegate, which the extra instruction fixes. Whether Luna accepts `REASONING_EFFORT` is untested. If Azure rejects the parameter, leave the variable unset.

The end-to-end path works. A spoken question reached the board and came back as a spoken answer.

## Privacy boundaries

The trace and logs keep only the tool name, the result size and the duration of a board call. Arguments and results appear as `[redacted]`. A test checks that marker values never reach the trace.

Board content can still appear in the spoken answer, in the transcript and in the final reasoning response, because the model repeats what it read. Board text is untrusted input and can carry prompt injection. We tell the model not to send board data into `web_search`, but that is an instruction and not a technical block.

While a board tool is available, the backend holds the model's text until the first tool result arrives, even when the model calls no tool. Web search already behaves this way.

## Not built

We did not add a Flow Map node or a delegation view for board calls. The Flow Map knows only browser, backend, Live, reasoning and Web IQ, so the calls show up in the raw events only. We also did not add caching, write access or more than one MCP server.

## Next candidate: a Foundry prompt agent

We researched calling a Microsoft Foundry prompt agent from the backend, using the Learn pages for [runtime components](https://learn.microsoft.com/azure/foundry/agents/concepts/runtime-components), [MCP tools](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/model-context-protocol) and [function calling](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/function-calling). The findings on 2026-10-29 were these.

- A prompt agent is a named, versioned resource. The Responses API invokes it at `{project endpoint}/openai/v1/responses` with `agent_reference: { name, type: "agent_reference" }`, and streaming works as before.
- The token scope is `https://ai.azure.com/.default`. Invoking an agent needs the Foundry Agent Consumer role, and creating one needs Foundry User.
- Function tools stay client-side, so our existing tool loop and the local MCP server keep working. A Foundry-hosted MCP tool cannot reach `localhost`, and we do not expose the board to make it reachable.
- Conversation state lives in Foundry unless `store` is `false`. Agent memory across sessions is preview.

We consider one stateless agent the smallest useful test. It proves the integration without storing board content in Foundry, and it avoids a router between two agents before one agent shows a limit. Conversations and several agents come after a concrete case that the transcript cannot cover.

Three checks come before any code. Does Foundry accept request-level tools next to `agent_reference`? If not, the MCP tools would have to be duplicated in the agent definition, and the test is no longer small. Does an agent accept our reasoning deployment as its model? How much latency does the extra hop add before the first spoken sentence? We could not verify whether the docs' two spellings, `agent_reference` and `agent`, are both accepted, and we inferred the GA status of the `v1` surface from missing preview labels.

The repository owner decides whether board content may live in Foundry conversations. Until then we keep `store: false`.

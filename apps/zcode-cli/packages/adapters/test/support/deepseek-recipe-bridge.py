#!/usr/bin/env python3
"""Minimal bridge: OpenAI chat-completions body (JSON on stdin) -> deepseek-recipe's
own conversion -> the resulting Conversation.messages (JSON on stdout).

Used only by apps/zcode-cli/packages/adapters/test/sando-deepseek-recipe-parity.test.mjs
to compare Sando's reasoning-history policy output against DeepSeek's own encoding
semantics (deepseek-recipe, MIT, https://pypi.org/project/deepseek-recipe/). No network
calls, no model inference: this only exercises deepseek-recipe's protocol conversion
(ChatCompletionRequest.convert), which is pure offline request-shape logic.

stdin:  {"model": str, "messages": [...], "tools"?: [...], "thinking"?: {...}}
        (same dict shape ChatCompletionRequest(body) accepts; see deepseek-recipe-python
        tests/test_bindings.py)
stdout: {"messages": [{"role", "content", "reasoning_content", "tool_calls": [{"id","name","arguments"}] | null,
                       "tool_call_id"}, ...]}
"""
import json
import sys

from deepseek_recipe import ChatCompletionRequest, ConversionOptions


def main() -> None:
    body = json.loads(sys.stdin.read())
    converted = ChatCompletionRequest(body).convert(ConversionOptions())
    out = []
    for m in converted.conversation.messages:
        tool_calls = m.tool_calls
        out.append(
            {
                "role": str(m.role),
                "content": m.content,
                "reasoning_content": m.reasoning_content,
                "tool_calls": (
                    [{"id": t.id, "name": t.name, "arguments": t.arguments} for t in tool_calls]
                    if tool_calls is not None
                    else None
                ),
                "tool_call_id": m.tool_call_id,
            }
        )
    json.dump({"messages": out}, sys.stdout)


if __name__ == "__main__":
    main()

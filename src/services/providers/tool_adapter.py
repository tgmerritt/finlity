"""Tool format conversion between Claude and OpenAI formats.

Claude format:
{
    "name": "get_weather",
    "description": "Get weather for a location",
    "input_schema": {
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "City name"}
        },
        "required": ["location"]
    }
}

OpenAI format:
{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get weather for a location",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City name"}
            },
            "required": ["location"]
        }
    }
}
"""

from typing import Any


def claude_tools_to_openai(claude_tools: list[dict]) -> list[dict]:
    """Convert Claude tool format to OpenAI tool format.

    Args:
        claude_tools: List of tools in Claude format

    Returns:
        List of tools in OpenAI format
    """
    openai_tools = []

    for tool in claude_tools:
        openai_tool = {
            "type": "function",
            "function": {
                "name": tool.get("name", ""),
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {}),
            },
        }
        openai_tools.append(openai_tool)

    return openai_tools


def openai_tools_to_claude(openai_tools: list[dict]) -> list[dict]:
    """Convert OpenAI tool format to Claude tool format.

    Args:
        openai_tools: List of tools in OpenAI format

    Returns:
        List of tools in Claude format
    """
    claude_tools = []

    for tool in openai_tools:
        if tool.get("type") == "function":
            func = tool.get("function", {})
            claude_tool = {
                "name": func.get("name", ""),
                "description": func.get("description", ""),
                "input_schema": func.get("parameters", {}),
            }
            claude_tools.append(claude_tool)

    return claude_tools


def claude_tool_result_to_openai(tool_call_id: str, result: Any) -> dict:
    """Convert a Claude tool result to OpenAI format.

    Args:
        tool_call_id: The ID of the tool call
        result: The result from the tool execution

    Returns:
        OpenAI-formatted tool result message
    """
    import json

    content = result if isinstance(result, str) else json.dumps(result)

    return {"role": "tool", "tool_call_id": tool_call_id, "content": content}


def openai_tool_result_to_claude(tool_call_id: str, result: Any) -> dict:
    """Convert an OpenAI tool result to Claude format.

    Args:
        tool_call_id: The ID of the tool call
        result: The result from the tool execution

    Returns:
        Claude-formatted tool result content block
    """
    import json

    content = result if isinstance(result, str) else json.dumps(result)

    return {"type": "tool_result", "tool_use_id": tool_call_id, "content": content}


def normalize_tool_call(tool_call: dict, source_format: str = "auto") -> dict:
    """Normalize a tool call to a standard internal format.

    Standard format:
    {
        "id": str,
        "name": str,
        "input": dict
    }

    Args:
        tool_call: Tool call in either Claude or OpenAI format
        source_format: "claude", "openai", or "auto" (detect automatically)

    Returns:
        Normalized tool call dict
    """
    # Auto-detect format
    if source_format == "auto":
        if "function" in tool_call:
            source_format = "openai"
        else:
            source_format = "claude"

    if source_format == "openai":
        # OpenAI format has function.name and function.arguments
        import json

        func = tool_call.get("function", {})
        args = func.get("arguments", "{}")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}

        return {
            "id": tool_call.get("id", ""),
            "name": func.get("name", ""),
            "input": args,
        }
    else:
        # Claude format already matches our standard
        return {
            "id": tool_call.get("id", ""),
            "name": tool_call.get("name", ""),
            "input": tool_call.get("input", {}),
        }

#!/usr/bin/env python3
"""Run one minimal-agent turn through the bundled Python SDK runtime."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from ondra_harness import Ondra


def main() -> None:
    """Parse one task and print the agent's final response."""
    parser = argparse.ArgumentParser()
    configured_home = os.environ.get("ONDRA_HOME", "")
    parser.add_argument("prompt", help="Task for the minimal agent")
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument(
        "--ondra-home",
        type=Path,
        default=Path(configured_home) if configured_home.strip() else None,
    )
    parser.add_argument("--profile", default="sdk-minimal")
    parser.add_argument("--session-id")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("ONDRA_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--max-tokens", type=int)
    args = parser.parse_args()
    if args.ondra_home is None:
        parser.error("--ondra-home or a non-empty ONDRA_HOME is required")

    workspace = args.workspace.resolve()
    ondra_home = args.ondra_home.resolve()
    with Ondra(
        provider=args.provider,
        model=args.model,
        max_tokens=args.max_tokens,
        cwd=str(workspace),
       ondra_home=str(ondra_home)),
        profile=args.profile,
    ) as harness:
        result = harness.run(args.prompt, session_id=args.session_id)
    print(result.final_response)


if __name__ == "__main__":
    main()

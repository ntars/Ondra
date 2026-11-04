"""Run a short SDK session, close immediately, and try restoring its history.

Requires an installed SDK/runtime and DEEPSEEK_API_KEY. Run this file directly.
The temporary Harness home is retained for inspection.
"""

from pathlib import Path
from tempfile import mkdtemp
from time import monotonic

from ondra_harness import Ondra, OndraConfig

root = Path(mkdtemp(prefix="ondra-shutdown-"))
config = OndraConfig(
    profile="sdk-minimal",
    ondra_home=str(root / "home"),
    cwd=str(root),
    shutdown_timeout_seconds=1.0,
)
print("Test directory:", root)

with Ondra(config) as harness:
    result = harness.run("只回复 OK，不要调用工具。")
    started = monotonic()

print(f"close() took {monotonic() - started:.3f}s")
print("Reply:", result.final_response)
if result.finish_reason != "completed":
    raise RuntimeError(f"Model turn failed ({result.finish_reason}); check credentials and the session log.")
print("History files:", list((root / "home" / "sessions").rglob("*.jsonl")))

# Recovery gets a separate budget so its own shutdown does not repeat the test.
config.shutdown_timeout_seconds = 30.0
with Ondra(config) as harness:
    harness.resume_session(result.session_id)
    print("History restored successfully:", result.session_id)

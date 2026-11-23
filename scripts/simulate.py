"""Run the agent-to-agent simulation and write a report.

    .venv\\Scripts\\python.exe scripts\\simulate.py               # against the running Champions agent (:9100)
    .venv\\Scripts\\python.exe scripts\\simulate.py --in-process  # no servers needed

Writes reports/simulation.md (and .json). Queries land in the Champions query
log, tagged source=simulator, so the Agent Lab (http://127.0.0.1:9100/lab) shows them.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from personal import simulator  # noqa: E402


async def main(in_process, personas):
    if in_process:
        from champions.app import create_app

        app = create_app()
        async with app.router.lifespan_context(app):
            return await simulator.run(transport=httpx.ASGITransport(app=app), personas=personas)
    return await simulator.run(personas=personas)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--in-process", action="store_true", help="run Champions inside this process")
    parser.add_argument("--persona", action="append", help="limit to these personas (repeatable)")
    args = parser.parse_args()
    # The report contains arrows and other non-ASCII text; Windows consoles default to cp1252.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    report = asyncio.run(main(args.in_process, args.persona))
    out = ROOT / "reports"
    out.mkdir(exist_ok=True)
    (out / "simulation.md").write_text(simulator.markdown(report), encoding="utf-8")
    (out / "simulation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(simulator.markdown(report))
    print(f"Written to {out / 'simulation.md'}")

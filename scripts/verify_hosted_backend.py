"""Read-check the fixed WasteGrid Render API and existing Supabase demo.

Reads the owner's ignored .env and .env.supabase-demo files. Only normal Auth
sessions are created. No password arguments or alternate destinations are accepted.
Warm the Free service with GET /health before running this command.
"""

import argparse
import sys

from scripts import verify_live_backend as live

HOSTED_API_URL = "https://wastegrid-api-dev.onrender.com"
EVIDENCE = live.ROOT / ".data" / "backend-hosted-render-verification.json"


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m scripts.verify_hosted_backend", description=__doc__
    )
    arguments = list(sys.argv[1:] if argv is None else argv)
    # argparse's default rejection echoes values, which may contain credentials.
    # Check before parsing so --help cannot hide an unsupported argument either.
    if any(argument not in ("-h", "--help") for argument in arguments):
        parser.error("Only --help is supported; read credentials from local env files.")
    parser.parse_args(arguments)
    # The credential-bearing checks may only target this reviewed deployment.
    # HTTP clients in live.run do not follow redirects; the local CLI stays local.
    return live.verify(HOSTED_API_URL, EVIDENCE)


if __name__ == "__main__":
    raise SystemExit(main())

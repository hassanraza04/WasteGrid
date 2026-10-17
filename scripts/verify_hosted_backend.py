"""Read-check the fixed WasteGrid Render API and existing Supabase demo.

Reads the owner's ignored .env and .env.supabase-demo files. Only normal Auth
sessions are created. No password arguments or alternate destinations are accepted.
Warm the Free service with GET /health before running this command.
"""

import argparse

from scripts import verify_live_backend as live

HOSTED_API_URL = "https://wastegrid-api-dev.onrender.com"
EVIDENCE = live.ROOT / ".data" / "backend-hosted-render-verification.json"


def main(argv=None):
    argparse.ArgumentParser(description=__doc__).parse_args(argv)
    # The credential-bearing checks may only target this reviewed deployment.
    # HTTP clients in live.run do not follow redirects; the local CLI stays local.
    return live.verify(HOSTED_API_URL, EVIDENCE)


if __name__ == "__main__":
    raise SystemExit(main())

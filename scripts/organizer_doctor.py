"""Read-only startup checks. Does not start workers, spend AI credits or mutate data."""

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import dotenv_values

REQUIRED_PATHS = {
    "/organizer/overview",
    "/organizer/report-index",
    "/organizer/job-index",
    "/organizer/reports/{report_id}",
    "/routing/previews",
    "/routing/previews/{preview_id}/geometry/{crew_id}",
}


def public_url(value, protocols):
    """Return a validated public URL without echoing malformed configuration."""
    if (
        not isinstance(value, str)
        or any(char.isspace() for char in value)
        or "\\" in value
    ):
        return None
    try:
        parsed = urlsplit(value)
        # Accessing .port validates nonnumeric and out-of-range ports. urlsplit
        # itself rejects malformed brackets and unsafe Unicode authorities.
        parsed.port
        if (
            parsed.scheme not in protocols
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            return None
    except ValueError:
        return None
    return parsed


def valid_dashboard_origin(value):
    """Accept local development or one HTTPS origin, never a URL path/pattern."""
    if value in {"http://localhost:5173", "http://127.0.0.1:5173"}:
        return True
    parsed = public_url(value, {"https"})
    if parsed is None:
        return False
    try:
        canonical = str(httpx.URL(value))
    except httpx.InvalidURL:
        return False
    # Comparing the entire authority also rejects empty query/fragment markers,
    # which urlsplit otherwise represents as empty strings. Bracketed IPv6 is
    # validated by urlsplit; ordinary hosts must not be wildcard/encoded patterns.
    return (
        not parsed.path
        and value == f"https://{parsed.netloc}"
        # Browser origins normalize host case and omit the default HTTPS port.
        and value == canonical
        and not any(char in parsed.hostname for char in "*%<>^|")
    )


def public_configuration(values):
    issues = []
    for name, protocols in (
        ("VITE_API_BASE_URL", {"http", "https"}),
        ("VITE_SUPABASE_URL", {"https"}),
    ):
        if public_url(values.get(name), protocols) is None:
            issues.append(
                f"{name} must be an absolute public URL without credentials, query or fragment"
            )
    if not (values.get("VITE_SUPABASE_PUBLISHABLE_KEY") or "").startswith(
        "sb_publishable_"
    ):
        issues.append("VITE_SUPABASE_PUBLISHABLE_KEY must be a public publishable key")
    origin = values.get("DASHBOARD_ORIGIN") or "http://127.0.0.1:5173"
    if not valid_dashboard_origin(origin):
        issues.append(
            "DASHBOARD_ORIGIN must exactly match a browser HTTPS origin without a path, query, "
            "fragment or credentials, or http://localhost:5173 or http://127.0.0.1:5173"
        )
    try:
        origins = json.loads(values.get("CORS_ORIGINS") or "[]")
    except (ValueError, TypeError):
        origins = None
    if (
        not isinstance(origins, list)
        or not all(isinstance(item, str) and item for item in origins)
        or origin not in origins
    ):
        issues.append(
            "CORS_ORIGINS must be a JSON list of strings containing the exact DASHBOARD_ORIGIN"
        )
    if (values.get("ORGANIZER_ROUTING_ENABLED") or "").lower() != "true":
        issues.append("ORGANIZER_ROUTING_ENABLED must be true")
    if (values.get("MESSAGING_PILOT_ENABLED") or "false").lower() != "false":
        issues.append("MESSAGING_PILOT_ENABLED must remain false")
    if public_url(values.get("ROUTING_OSRM_BASE_URL"), {"http", "https"}) is None:
        issues.append("ROUTING_OSRM_BASE_URL must configure a public road provider URL")
    return issues


def deployed_checks(client, base_url, origin, revision):
    issues = []
    ready = client.get(f"{base_url}/ready")
    if ready.status_code != 200:
        issues.append("API readiness or migration check failed")
    expected_headers = {
        "x-wastegrid-revision": revision,
        "x-wastegrid-organizer-routing": "true",
        "x-wastegrid-messaging-pilot": "false",
        "x-wastegrid-road-service": "true",
    }
    for name, value in expected_headers.items():
        if ready.headers.get(name) != value:
            issues.append(f"Deployed {name} does not match the required configuration")
    schema_response = client.get(f"{base_url}/openapi.json")
    schema_response.raise_for_status()
    schema = schema_response.json()
    if not REQUIRED_PATHS.issubset(schema.get("paths", {})):
        issues.append("Deployed API is missing organiser prototype endpoints")
    components = schema.get("components", {}).get("schemas", {})
    if "dispatch_receipt" not in components.get("RoutePreviewView", {}).get(
        "properties", {}
    ):
        issues.append("Deployed preview recovery receipt contract is missing")
    if "constraints" not in components.get("ComputeRoutes", {}).get("properties", {}):
        issues.append("Deployed routing controls contract is missing")
    response = client.options(
        f"{base_url}/organizer/overview",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    if (
        response.status_code != 200
        or response.headers.get("access-control-allow-origin") != origin
    ):
        issues.append("Deployed CORS does not allow the exact dashboard origin")
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--expected-revision")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    values = dotenv_values(args.env_file)
    issues = public_configuration(values)
    if not args.offline:
        if not re.fullmatch(r"[0-9a-f]{40}", args.expected_revision or ""):
            issues.append(
                "A verified full --expected-revision is required for deployed checks"
            )
        elif not issues:
            try:
                with httpx.Client(timeout=45, follow_redirects=False) as client:
                    issues.extend(
                        deployed_checks(
                            client,
                            values["VITE_API_BASE_URL"].rstrip("/"),
                            values.get("DASHBOARD_ORIGIN") or "http://127.0.0.1:5173",
                            args.expected_revision,
                        )
                    )
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                issues.append(
                    "Deployed verification unavailable; service may be waking up. Retry explicitly"
                )
    print(
        json.dumps(
            {
                "ok": not issues,
                "scope": "configuration only; worker heartbeat and observed model success are separate",
                "issues": issues,
            },
            indent=2,
        )
    )
    return 1 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main())

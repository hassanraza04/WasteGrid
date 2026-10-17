"""Assess one local JPG/PNG through the existing Chalk client; no database writes."""

import argparse
import base64
import json
import sys
from io import BytesIO
from pathlib import Path
from time import perf_counter

import httpx
from PIL import Image
from pydantic import ValidationError

from api.assessment import calculate_priority
from api.config import Settings
from api.integrations import ChalkAssessmentClient
from api.schemas import Location, ResidentAnswers


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("photo", type=Path, help="Local JPG or PNG to send to Chalk")
    parser.add_argument(
        "--model", help="Exact Chalk-prefixed model ID or published route"
    )
    parser.add_argument("--note", default=None)
    parser.add_argument("--latitude", type=float)
    parser.add_argument("--longitude", type=float)
    parser.add_argument("--fire", choices=("yes", "no"))
    parser.add_argument("--sharp-objects", choices=("yes", "no"))
    args = parser.parse_args(argv)
    settings = Settings()
    if args.model:
        settings = settings.model_copy(update={"chalk_model": args.model})
    missing = []
    if not settings.chalk_router_api_key:
        missing.append("CHALK_ROUTER_API_KEY")
    if not settings.chalk_env_id:
        missing.append("CHALK_ENV_ID")
    if not args.model and "chalk_model" not in settings.model_fields_set:
        missing.append("CHALK_MODEL (or --model)")
    if missing:
        print(
            "Configure backend .env/environment: " + ", ".join(missing), file=sys.stderr
        )
        return 2
    if (args.latitude is None) != (args.longitude is None):
        parser.error("Provide both --latitude and --longitude")
    try:
        location = (
            Location(latitude=args.latitude, longitude=args.longitude).model_dump()
            if args.latitude is not None
            else None
        )
        if args.photo.stat().st_size > settings.photo_max_bytes:
            parser.error("Photo exceeds the backend upload size limit")
        content = args.photo.read_bytes()
        with Image.open(BytesIO(content)) as photo:
            mime = {"JPEG": "image/jpeg", "PNG": "image/png"}.get(photo.format)
            if mime is None:
                parser.error("Use a JPG or PNG photo")
            photo.verify()
    except (OSError, ValidationError, Image.DecompressionBombError):
        print(
            "Invalid photo or coordinates; use a readable JPG/PNG and valid GPS.",
            file=sys.stderr,
        )
        return 2
    answers = ResidentAnswers(
        fire=None if args.fire is None else args.fire == "yes",
        sharp_objects=(
            None if args.sharp_objects is None else args.sharp_objects == "yes"
        ),
    )
    client = ChalkAssessmentClient(settings)
    started = perf_counter()
    try:
        data_url = f"data:{mime};base64," + base64.b64encode(content).decode("ascii")
        result = client.assess(
            data_url, args.note, location, answers.model_dump(exclude_none=True)
        )
        print(
            json.dumps(
                {
                    "model": settings.chalk_model,
                    "elapsed_seconds": round(perf_counter() - started, 3),
                    "assessment": result.model_dump(mode="json"),
                    **calculate_priority(result, answers).model_dump(),
                },
                indent=2,
            )
        )
        return 0
    except httpx.HTTPStatusError as exc:
        print(
            f"Chalk/provider rejected the request (HTTP {exc.response.status_code}). Check gateway key, environment, model access and provider credits.",
            file=sys.stderr,
        )
    except httpx.TimeoutException:
        print("Assessment timed out; no retry was made.", file=sys.stderr)
    except httpx.RequestError:
        print("Cannot reach the configured Chalk gateway.", file=sys.stderr)
    except (ValidationError, KeyError, IndexError, ValueError, TypeError):
        print(
            "Gateway output did not match the assessment contract; no repair or retry was made.",
            file=sys.stderr,
        )
    finally:
        client.close()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

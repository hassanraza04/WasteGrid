from io import BytesIO
from urllib.parse import quote
from uuid import UUID

import httpx
from fastapi import HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from api.config import Settings

FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


def read_photo(upload: UploadFile, limit: int) -> tuple[bytes, str]:
    content = upload.file.read(limit + 1)
    if len(content) > limit:
        raise HTTPException(413, "Photo exceeds upload limit")
    try:
        with Image.open(BytesIO(content)) as image:
            mime = FORMATS.get(image.format)
            if mime is None or mime != upload.content_type:
                raise HTTPException(
                    415, "Use a JPEG, PNG, or WebP photo with matching content type"
                )
            if image.width * image.height > 25_000_000:
                raise HTTPException(413, "Photo exceeds 25 megapixels")
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(415, "Invalid photo") from None
    return content, mime


class SupabaseCloud:
    """Small server-side HTTP adapter; no client state or privileged key exposure."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = httpx.Client(timeout=20)

    def close(self):
        self.client.close()

    def call(self, method: str, path: str, *, token: str | None = None, **kwargs):
        key = self.settings.supabase_secret_key
        if not self.settings.supabase_url or key is None:
            raise HTTPException(503, "Supabase is not configured")
        headers = {"apikey": key.get_secret_value()}
        # New secret API keys go only in apikey. Legacy service-role JWTs also
        # need Authorization for Storage. User verification always uses the JWT.
        if token:
            headers["Authorization"] = "Bearer " + token
        elif not key.get_secret_value().startswith("sb_secret_"):
            headers["Authorization"] = "Bearer " + key.get_secret_value()
        headers.update(kwargs.pop("headers", {}))
        try:
            response = self.client.request(
                method,
                self.settings.supabase_url.rstrip("/") + path,
                headers=headers,
                **kwargs,
            )
        except httpx.HTTPError:
            raise HTTPException(503, "Supabase is temporarily unavailable") from None
        if response.status_code >= 400:
            if path == "/auth/v1/user" and response.status_code in (401, 403):
                raise HTTPException(401, "Invalid or expired staff session")
            raise HTTPException(503, "Supabase operation failed")
        return response

    def user_id(self, token: str) -> UUID:
        try:
            return UUID(self.call("GET", "/auth/v1/user", token=token).json()["id"])
        except (ValueError, KeyError):
            raise HTTPException(
                503, "Invalid authentication provider response"
            ) from None

    def object_path(self, path: str) -> str:
        bucket = quote(self.settings.supabase_photo_bucket, safe="")
        return bucket + "/" + quote(path, safe="/")

    def upload(self, path: str, content: bytes, content_type: str):
        self.call(
            "POST",
            "/storage/v1/object/" + self.object_path(path),
            content=content,
            headers={"Content-Type": content_type, "x-upsert": "false"},
        )

    def delete(self, path: str):
        self.call(
            "DELETE",
            "/storage/v1/object/" + quote(self.settings.supabase_photo_bucket, safe=""),
            json={"prefixes": [path]},
        )

    def signed_url(self, path: str) -> str:
        result = self.call(
            "POST",
            "/storage/v1/object/sign/" + self.object_path(path),
            json={"expiresIn": self.settings.photo_url_ttl_seconds},
        ).json()
        relative = result.get("signedURL", "")
        if not relative.startswith("/object/sign/"):
            raise HTTPException(503, "Invalid storage provider response")
        return self.settings.supabase_url.rstrip("/") + "/storage/v1" + relative

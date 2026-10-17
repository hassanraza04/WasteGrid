from dataclasses import dataclass
from hashlib import sha256
from hmac import compare_digest
from uuid import UUID

from fastapi import Depends, HTTPException, Request, Security
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from api.db import get_db
from api.models import Report, StaffRole

bearer_scheme = HTTPBearer(auto_error=False, scheme_name="ReportOrStaffBearer")
messaging_scheme = APIKeyHeader(
    name="X-Integration-Key", auto_error=False, scheme_name="MessagingKey"
)
agent_scheme = APIKeyHeader(
    name="X-Agent-Key", auto_error=False, scheme_name="AgentKey"
)


def authorization_header(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer_scheme),
):
    return f"Bearer {credentials.credentials}" if credentials else None


def digest(value: str) -> str:
    return sha256(value.encode()).hexdigest()


@dataclass(frozen=True)
class Principal:
    user_id: UUID
    role: str
    crew_id: UUID | None


def bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Bearer authentication required")
    return authorization[7:]


def get_staff(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Depends(authorization_header),
) -> Principal:
    token = bearer(authorization)
    if token.startswith("wg_r_"):
        raise HTTPException(403, "Staff account required")
    # Supabase Auth verifies the token remotely, including legacy signing keys.
    uid = request.app.state.cloud.user_id(token)
    role = db.get(StaffRole, uid)
    if role is None:
        raise HTTPException(403, "No staff role provisioned")
    return Principal(uid, role.role, role.crew_id)


def organizer(principal: Principal = Depends(get_staff)) -> Principal:
    if principal.role != "organizer":
        raise HTTPException(403, "Organizer role required")
    return principal


def require_resident(report: Report, authorization: str | None):
    if not compare_digest(report.token_hash, digest(bearer(authorization))):
        raise HTTPException(404, "Report not found")


def messaging_access(
    request: Request, x_integration_key: str | None = Security(messaging_scheme)
):
    configured = request.app.state.settings.messaging_api_key
    if configured is None:
        raise HTTPException(503, "Messaging integration is not configured")
    if not x_integration_key or not compare_digest(
        configured.get_secret_value(), x_integration_key
    ):
        raise HTTPException(401, "Integration authentication required")


def agent_access(request: Request, key: str | None = Security(agent_scheme)):
    configured = request.app.state.settings.agent_api_key
    if configured is None:
        raise HTTPException(503, "Agent integration is not configured")
    if not key or not compare_digest(configured.get_secret_value(), key):
        raise HTTPException(401, "Agent authentication required")

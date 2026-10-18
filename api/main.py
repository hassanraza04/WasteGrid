"""FastAPI composition root. Provider work remains behind explicit boundaries."""

import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import timedelta, timezone
from hashlib import sha256
from hmac import compare_digest
from secrets import token_urlsafe
from uuid import UUID, uuid4

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from api.auth import (
    Principal,
    agent_access,
    authorization_header,
    digest,
    get_staff,
    messaging_access,
    organizer,
    require_resident,
)
from api.config import Settings
from api.db import get_db, make_engine
from api.http_limits import BodyLimitMiddleware
from api.models import (
    Conversation,
    ConversationMessage,
    Crew,
    Event,
    Job,
    LinkCode,
    MessagingPilot,
    MessagingThread,
    OutgoingMessage,
    Photo,
    Plan,
    Report,
    Task,
    now,
)
from api.pilot import allowed_report, enabled, ensure_run
from api.pilot import router as pilot_router
from api.routing import routing_router
from api.schemas import (
    BindConversation,
    ClaimMessages,
    Clarification,
    CompletionCommand,
    ConversationLookup,
    ConversationMessages,
    ConversationMessageView,
    ConversationView,
    CrewPatch,
    CrewView,
    CurrentPlan,
    DeliveryAck,
    DeliveryFailure,
    DeliveryStatus,
    ErrorResponse,
    GeneratePlan,
    Health,
    IncomingFollowup,
    JobDetails,
    JobPatch,
    JobView,
    LinkCreated,
    Location,
    OrganizerReportView,
    OutgoingView,
    PhotoAccess,
    Recheck,
    ReportCreated,
    ReportDetails,
    ReportUpdates,
    ReportView,
    ResidentAnswers,
    Snapshot,
    TaskView,
    TriageRecommendation,
)
from api.services import (
    UPDATE_MESSAGES,
    apply_clarification,
    apply_recheck,
    assert_version,
    command_seen,
    enqueue,
    event,
    flag_nearby_report,
    invalidate_plan,
    organizer_report_view,
    report_event_condition,
    report_update,
    report_view,
    snapshot,
)
from api.storage import SupabaseCloud, read_photo
from api.workflows import apply_triage, change_crew
from api.workflows import change_job as apply_job_change

logger = logging.getLogger(__name__)


def find_report(db: Session, report_id: UUID) -> Report:
    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(404, "Report not found")
    return report


def job_access(db: Session, job_id: UUID, staff: Principal, *, lock=False) -> Job:
    query = select(Job).where(Job.id == job_id)
    if staff.role == "crew":
        query = query.where(Job.assigned_crew_id == staff.crew_id)
    job = db.scalar(query.with_for_update() if lock else query)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


def report_access(
    request: Request, db: Session, report: Report, authorization: str | None
):
    if authorization and authorization.startswith("Bearer wg_r_"):
        require_resident(report, authorization)
    else:
        staff = get_staff(request, db, authorization)
        if staff.role == "crew":
            if not report.job_id:
                raise HTTPException(404, "Report not found")
            job_access(db, report.job_id, staff)


def upload_commit(request: Request, db: Session, path: str, content: bytes, mime: str):
    cloud = request.app.state.cloud
    try:
        cloud.upload(path, content, mime)
        db.commit()
    except Exception:
        db.rollback()
        # A lost commit acknowledgement may still mean the DB committed. Never
        # delete its photo unless a fresh connection confirms no metadata exists.
        try:
            with Session(request.app.state.engine) as check:
                committed = check.scalar(
                    select(Photo.id).where(Photo.object_path == path)
                )
            if not committed:
                cloud.delete(path)
        except Exception:
            logger.error("Photo cleanup needs reconciliation for object %s", path)
        raise


def linked_conversation(
    db: Session, conversation_id: UUID, *, mutation=False
) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or not conversation.active:
        raise HTTPException(404, "Conversation not found")
    if mutation and conversation.thread_id:
        thread = db.get(MessagingThread, conversation.thread_id)
        if thread and thread.pilot_id:
            raise HTTPException(
                409, "Pilot actions must use the durable messaging inbox"
            )
    return conversation


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        app.state.cloud.close()
        if app.state.engine:
            app.state.engine.dispose()

    app = FastAPI(
        title="WasteGrid API",
        version="0.2.0",
        lifespan=lifespan,
        responses={
            code: {
                "model": ErrorResponse,
                # Python versions use different default phrases for HTTP 413.
                **({"description": "Content Too Large"} if code == 413 else {}),
            }
            for code in (401, 403, 404, 409, 413, 415, 503)
        },
    )
    app.state.settings = settings
    app.state.engine = make_engine(settings)
    app.state.cloud = SupabaseCloud(settings)
    app.include_router(routing_router(settings))
    app.include_router(pilot_router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Integration-Key",
            "X-Report-Token",
            "X-Agent-Key",
        ],
    )

    app.add_middleware(
        BodyLimitMiddleware, limit=settings.photo_max_bytes + 1024 * 1024
    )

    @app.middleware("http")
    async def private_responses(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        revision = os.environ.get("RENDER_GIT_COMMIT", "")
        if re.fullmatch(r"[0-9a-f]{40}", revision):
            response.headers["X-WasteGrid-Revision"] = revision
        response.headers["X-WasteGrid-Organizer-Routing"] = str(
            settings.organizer_routing_enabled
        ).lower()
        response.headers["X-WasteGrid-Messaging-Pilot"] = str(
            settings.messaging_pilot_enabled
        ).lower()
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # FastAPI normally echoes rejected input, which can contain credentials.
        return JSONResponse(
            status_code=422,
            content={
                "detail": [
                    {"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]}
                    for e in exc.errors()
                ]
            },
        )

    @app.exception_handler(IntegrityError)
    async def conflicting_write(request, exc):
        return JSONResponse(
            status_code=409,
            content={"detail": "Conflicting write; fetch current state"},
        )

    @app.exception_handler(SQLAlchemyError)
    async def unavailable_database(request, exc):
        return JSONResponse(
            status_code=503, content={"detail": "Database operation unavailable"}
        )

    @app.get("/health", response_model=Health)
    def health():
        return {"status": "ok"}

    @app.get("/ready", response_model=Health)
    def ready(db: Session = Depends(get_db)):
        if not settings.supabase_url or not settings.supabase_secret_key:
            raise HTTPException(503, "Supabase is not configured")
        db.execute(select(Task.id).limit(0))
        db.execute(select(MessagingPilot.id).limit(0))
        return {"status": "ready"}

    @app.post("/reports", response_model=ReportCreated, status_code=201)
    def create_report(
        request: Request,
        photo: UploadFile = File(),
        latitude: float | None = Form(default=None),
        longitude: float | None = Form(default=None),
        landmark: str | None = Form(default=None, max_length=300),
        note: str | None = Form(default=None, max_length=2000),
        resident_fire: bool | None = Form(default=None),
        resident_sharp_objects: bool | None = Form(default=None),
        title: str | None = Form(default=None, min_length=1, max_length=160),
        address: str | None = Form(default=None, min_length=1, max_length=500),
        client_report_id: UUID | None = Form(default=None),
        x_report_token: str | None = Header(
            default=None, pattern=r"^wg_r_[A-Za-z0-9_-]{43}$"
        ),
        db: Session = Depends(get_db),
    ):
        if any(value is not None and not value.strip() for value in (title, address)):
            raise HTTPException(422, "Title and address must not be blank")
        title = title.strip() if title is not None else None
        address = address.strip() if address is not None else None
        if (latitude is None) != (longitude is None):
            raise HTTPException(422, "Provide both latitude and longitude, or neither")
        try:
            location = (
                Location(latitude=latitude, longitude=longitude, landmark=landmark)
                if latitude is not None
                else None
            )
        except ValidationError:
            raise HTTPException(422, "Invalid coordinates or landmark") from None
        content, mime = read_photo(photo, settings.photo_max_bytes)
        if (client_report_id is None) != (x_report_token is None):
            raise HTTPException(
                422,
                "Retry-safe submission requires both client_report_id and X-Report-Token",
            )
        request_content = {
            "photo": sha256(content).hexdigest(),
            "location": location.model_dump() if location else None,
            "note": note,
        }
        # Preserve fingerprints for retries from callers predating these fields.
        if title is not None or address is not None:
            request_content.update(title=title, address=address)
        resident_answers = ResidentAnswers(
            fire=resident_fire, sharp_objects=resident_sharp_objects
        ).model_dump(exclude_none=True)
        # Omitted answers preserve fingerprints for older retry-safe clients.
        if resident_answers:
            request_content["resident_answers"] = resident_answers
        request_hash = digest(json.dumps(request_content, sort_keys=True))
        if client_report_id:
            previous = db.get(Report, client_report_id)
            if previous:
                require_resident(previous, "Bearer " + x_report_token)
                if previous.request_hash != request_hash:
                    raise HTTPException(
                        409, "Report ID already used with different content"
                    )
                return ReportCreated(
                    report=report_view(db, previous), access_token=x_report_token
                )
        if location is None:
            raise HTTPException(
                422, "GPS coordinates or a confirmed map pin are required"
            )
        report_id, photo_id = client_report_id or uuid4(), uuid4()
        token = x_report_token or "wg_r_" + token_urlsafe(32)
        path = f"reports/{report_id}/{photo_id}"
        report = Report(
            id=report_id,
            token_hash=digest(token),
            photo_id=photo_id,
            location=location.model_dump() if location else None,
            note=note,
            title=title if title is not None else "Cleanup report",
            address=address,
            request_hash=request_hash,
            resident_answers=resident_answers,
        )
        db.add(report)
        db.flush()
        db.add(
            Photo(
                id=photo_id,
                report_id=report_id,
                object_path=path,
                content_type=mime,
                size_bytes=len(content),
            )
        )
        event(db, "report.received", report_id=report_id)
        flag_nearby_report(db, report, settings.duplicate_radius_meters)
        enqueue(
            db, "assessment", f"assessment:{report_id}", {"report_id": str(report_id)}
        )
        upload_commit(request, db, path, content, mime)
        return ReportCreated(report=report_view(db, report), access_token=token)

    @app.get("/reports/by-reference/{reference}", response_model=ReportView)
    def get_report_by_reference(
        reference: str,
        request: Request,
        authorization: str | None = Depends(authorization_header),
        db: Session = Depends(get_db),
    ):
        report = db.scalar(
            select(Report).where(Report.public_reference == reference.strip().upper())
        )
        if report is None:
            raise HTTPException(404, "Report not found")
        report_access(request, db, report, authorization)
        return report_view(db, report)

    @app.get("/reports/{report_id}", response_model=ReportView)
    def get_report(
        report_id: UUID,
        request: Request,
        authorization: str | None = Depends(authorization_header),
        db: Session = Depends(get_db),
    ):
        report = find_report(db, report_id)
        report_access(request, db, report, authorization)
        return report_view(db, report)

    @app.get("/reports/{report_id}/updates", response_model=ReportUpdates)
    def get_report_updates(
        report_id: UUID,
        request: Request,
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        authorization: str | None = Depends(authorization_header),
        db: Session = Depends(get_db),
    ):
        report = find_report(db, report_id)
        report_access(request, db, report, authorization)
        condition = report_event_condition(report) & Event.kind.in_(UPDATE_MESSAGES)
        total = db.scalar(select(func.count()).select_from(Event).where(condition))
        rows = db.scalars(
            select(Event)
            .where(condition)
            .order_by(Event.created_at, Event.id)
            .limit(limit)
            .offset(offset)
        )
        return ReportUpdates(
            items=[report_update(row) for row in rows],
            limit=limit,
            offset=offset,
            total=total,
        )

    @app.get("/reports/{report_id}/messages", response_model=ConversationMessages)
    def get_report_messages(
        report_id: UUID,
        request: Request,
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        authorization: str | None = Depends(authorization_header),
        db: Session = Depends(get_db),
    ):
        report = find_report(db, report_id)
        if authorization and authorization.startswith("Bearer wg_r_"):
            require_resident(report, authorization)
        else:
            staff = get_staff(request, db, authorization)
            if staff.role != "organizer":
                raise HTTPException(403, "Organizer access required")
        condition = Conversation.report_id == report.id
        total = db.scalar(
            select(func.count())
            .select_from(ConversationMessage)
            .join(Conversation)
            .where(condition)
        )
        rows = db.scalars(
            select(ConversationMessage)
            .join(Conversation)
            .where(condition)
            .order_by(ConversationMessage.created_at, ConversationMessage.id)
            .limit(limit)
            .offset(offset)
        )
        return ConversationMessages(
            items=[ConversationMessageView.model_validate(row) for row in rows],
            limit=limit,
            offset=offset,
            total=total,
        )

    @app.get("/organizer/reports", response_model=list[OrganizerReportView])
    def list_reports(
        limit: int = 100,
        offset: int = 0,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        if not 1 <= limit <= 100 or offset < 0:
            raise HTTPException(422, "Use limit 1..100 and nonnegative offset")
        reports = db.scalars(
            select(Report)
            .order_by(Report.created_at.desc(), Report.id)
            .limit(limit)
            .offset(offset)
        )
        return [organizer_report_view(db, report) for report in reports]

    @app.post(
        "/reports/{report_id}/followup-link",
        response_model=LinkCreated,
        status_code=201,
    )
    def followup_link(
        report_id: UUID,
        authorization: str | None = Depends(authorization_header),
        db: Session = Depends(get_db),
    ):
        report = find_report(db, report_id)
        require_resident(report, authorization)
        if not enabled(settings):
            raise HTTPException(503, "The supervised messaging pilot is not configured")
        if not allowed_report(settings, report):
            raise HTTPException(
                403, "This report is outside the supervised messaging pilot"
            )
        ensure_run(db, settings)
        code = token_urlsafe(32)
        expires = now() + timedelta(minutes=10)
        db.add(
            LinkCode(code_hash=digest(code), report_id=report_id, expires_at=expires)
        )
        db.commit()
        return LinkCreated(
            link_code=code,
            expires_at=expires,
            recipient=settings.messaging_imessage_recipient or None,
            channel="imessage",
        )

    @app.get("/photos/{photo_id}/access", response_model=PhotoAccess)
    def photo_access(
        photo_id: UUID,
        request: Request,
        authorization: str | None = Depends(authorization_header),
        db: Session = Depends(get_db),
    ):
        photo = db.get(Photo, photo_id)
        if photo is None:
            raise HTTPException(404, "Photo not found")
        if photo.report_id:
            report_access(request, db, find_report(db, photo.report_id), authorization)
        elif authorization and authorization.startswith("Bearer wg_r_"):
            candidates = db.scalars(select(Report).where(Report.job_id == photo.job_id))
            token_hash = digest(authorization[7:])
            if not any(compare_digest(r.token_hash, token_hash) for r in candidates):
                raise HTTPException(404, "Photo not found")
        else:
            job_access(db, photo.job_id, get_staff(request, db, authorization))
        return PhotoAccess(
            url=request.app.state.cloud.signed_url(photo.object_path),
            expires_in=settings.photo_url_ttl_seconds,
        )

    @app.get("/jobs", response_model=list[JobView])
    def jobs(db: Session = Depends(get_db), staff: Principal = Depends(get_staff)):
        query = (
            select(Job)
            .order_by(
                Job.assigned_crew_id, Job.route_position.asc().nulls_last(), Job.id
            )
            .limit(100)
        )
        if staff.role == "crew":
            query = query.where(Job.assigned_crew_id == staff.crew_id)
        return db.scalars(query).all()

    @app.get("/jobs/{job_id}", response_model=JobDetails)
    def job_details(
        job_id: UUID,
        db: Session = Depends(get_db),
        staff: Principal = Depends(get_staff),
    ):
        job = job_access(db, job_id, staff)
        report_ids = list(db.scalars(select(Report.id).where(Report.job_id == job_id)))
        photo_ids = list(
            db.scalars(
                select(Photo.id).where(
                    (Photo.job_id == job_id) | Photo.report_id.in_(report_ids)
                )
            )
        )
        return {
            "job": JobView.model_validate(job),
            "photo_ids": photo_ids,
            "events": list(
                db.scalars(
                    select(Event)
                    .where(Event.job_id == job_id)
                    .order_by(Event.created_at, Event.id)
                )
            ),
        }

    @app.patch("/jobs/{job_id}", response_model=JobView)
    def change_job(
        job_id: UUID,
        body: JobPatch,
        db: Session = Depends(get_db),
        staff: Principal = Depends(get_staff),
    ):
        job = job_access(db, job_id, staff, lock=True)
        if (
            settings.organizer_routing_enabled
            and staff.role == "organizer"
            and (
                "assigned_crew_id" in body.model_fields_set
                or body.status == "unassigned"
                or body.held is True
            )
        ):
            # A resident recheck pauses its old route. Only an audited organiser
            # resolution may release that stop; all other ownership edits still
            # go through dispatch. Preserve exact command retries after release.
            recheck_release = (
                body.status == "unassigned"
                and not body.model_fields_set & {"assigned_crew_id", "held", "locked"}
                and (
                    job.status == "recheck_requested"
                    or command_seen(db, job.id, body, "job.changed")[0]
                )
            )
            if not recheck_release:
                raise HTTPException(
                    409, "Use route preview and dispatch to change assignment ownership"
                )
        apply_job_change(
            db,
            job,
            body,
            actor=str(staff.user_id),
            is_organizer=staff.role == "organizer",
        )
        db.commit()
        return job

    @app.post("/jobs/{job_id}/completion", response_model=JobView)
    def complete_job(
        job_id: UUID,
        request: Request,
        photo: UploadFile = File(),
        command_id: UUID = Form(),
        expected_version: int = Form(ge=1),
        note: str | None = Form(default=None, max_length=2000),
        db: Session = Depends(get_db),
        staff: Principal = Depends(get_staff),
    ):
        if staff.role != "crew":
            raise HTTPException(403, "Assigned crew account required")
        job = job_access(db, job_id, staff, lock=True)
        content, mime = read_photo(photo, settings.photo_max_bytes)
        body = CompletionCommand(
            command_id=command_id,
            expected_version=expected_version,
            photo_hash=sha256(content).hexdigest(),
            note=note,
        )
        seen, fingerprint = command_seen(db, job.id, body, "job.completed")
        if seen:
            return job
        assert_version(job.version, expected_version)
        if job.status != "in_progress":
            raise HTTPException(409, "Start the job before submitting completion")
        photo_id = uuid4()
        path = f"jobs/{job_id}/{photo_id}"
        db.add(
            Photo(
                id=photo_id,
                job_id=job_id,
                object_path=path,
                content_type=mime,
                size_bytes=len(content),
            )
        )
        job.status = "completed"
        job.version += 1
        record = event(
            db,
            "job.completed",
            job_id=job.id,
            command_id=command_id,
            request_hash=fingerprint,
        )
        record.details = {
            "note": note,
            "photo_id": str(photo_id),
            "verification": "crew_submitted",
            "crew_id": str(job.assigned_crew_id),
            "consumed_minutes": job.estimated_service_minutes + job.travel_minutes,
        }
        record.actor = str(staff.user_id)
        invalidate_plan(db)
        upload_commit(request, db, path, content, mime)
        return job

    @app.get("/crews", response_model=list[CrewView])
    def crews(db: Session = Depends(get_db), staff: Principal = Depends(organizer)):
        return db.scalars(select(Crew).order_by(Crew.name)).all()

    @app.patch("/crews/{crew_id}", response_model=CrewView)
    def update_crew(
        crew_id: UUID,
        body: CrewPatch,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        crew = db.scalar(select(Crew).where(Crew.id == crew_id).with_for_update())
        if crew is None:
            raise HTTPException(404, "Crew not found")
        change_crew(
            db,
            crew,
            body,
            actor=str(staff.user_id),
            organizer_routing=settings.organizer_routing_enabled,
        )
        db.commit()
        return crew

    @app.get("/plans/current", response_model=CurrentPlan)
    def current_plan(
        db: Session = Depends(get_db), staff: Principal = Depends(organizer)
    ):
        plan = db.scalar(
            select(Plan).order_by(Plan.created_at.desc(), Plan.id).limit(1)
        )
        return {
            "plan": (
                {
                    **plan.payload,
                    "id": plan.id,
                    "stale": plan.stale,
                    "created_at": plan.created_at,
                }
                if plan
                else None
            )
        }

    @app.post("/plans/generate", response_model=TaskView, status_code=202)
    def generate_plan(
        body: GeneratePlan,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        if settings.organizer_routing_enabled:
            raise HTTPException(409, "Use /routing/previews then organiser dispatch")
        task = enqueue(db, "plan", f"manual-plan:{body.command_id}", {})
        db.commit()
        return task

    @app.get("/auth/me", response_model=Principal)
    def me(staff: Principal = Depends(get_staff)):
        return staff

    @app.get("/organizer/reports/{report_id}", response_model=ReportDetails)
    def organizer_report(
        report_id: UUID,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        report = find_report(db, report_id)
        events = db.scalars(
            select(Event)
            .where(
                or_(Event.report_id == report_id, Event.job_id == report.job_id)
                if report.job_id
                else Event.report_id == report_id
            )
            .order_by(Event.created_at, Event.id)
        ).all()
        return {"report": organizer_report_view(db, report), "events": events}

    @app.post(
        "/organizer/reports/{report_id}/decision", response_model=OrganizerReportView
    )
    def organizer_decision(
        report_id: UUID,
        body: TriageRecommendation,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        if body.report_id != report_id:
            raise HTTPException(422, "Report ID does not match request path")
        report = apply_triage(
            db, body, actor=str(staff.user_id), organizer_override=True
        )
        db.commit()
        return organizer_report_view(db, report)

    @app.get("/tasks", response_model=list[TaskView])
    def tasks(db: Session = Depends(get_db), staff: Principal = Depends(organizer)):
        return db.scalars(
            select(Task).order_by(Task.created_at.desc()).limit(100)
        ).all()

    @app.get("/tasks/{task_id}", response_model=TaskView)
    def task_status(
        task_id: UUID,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        task = db.get(Task, task_id)
        if task is None:
            raise HTTPException(404, "Task not found")
        return task

    @app.post("/tasks/{task_id}/retry", response_model=TaskView)
    def retry_task(
        task_id: UUID,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        task = db.get(Task, task_id)
        if task is None:
            raise HTTPException(404, "Task not found")
        if task.status != "failed":
            raise HTTPException(409, "Only failed tasks can be retried")
        if task.kind == "assessment":
            raise HTTPException(
                409, "One-call assessments require organizer review after failure"
            )
        task.status, task.attempts, task.next_attempt_at = "pending", 0, now()
        db.commit()
        return task

    internal = [Depends(messaging_access)]

    @app.post(
        "/internal/conversations/bind",
        response_model=ConversationView,
        dependencies=internal,
    )
    def bind_conversation(body: BindConversation, db: Session = Depends(get_db)):
        code = db.scalar(
            select(LinkCode)
            .where(LinkCode.code_hash == digest(body.link_code))
            .with_for_update()
        )
        if code is None:
            raise HTTPException(404, "Invalid link code")
        if (
            settings.messaging_pilot_enabled
            and code.report_id in settings.messaging_pilot_report_ids
        ):
            raise HTTPException(409, "Pilot links must use the durable messaging inbox")
        existing = db.scalar(
            select(Conversation).where(
                Conversation.channel == body.channel,
                Conversation.external_id == body.external_id,
            )
        )
        if code.consumed_at:
            if existing and existing.report_id == code.report_id:
                return existing
            raise HTTPException(409, "Link code already consumed")
        if code.expires_at.replace(tzinfo=timezone.utc) <= now():
            raise HTTPException(410, "Link code expired")
        if existing and existing.report_id != code.report_id:
            raise HTTPException(409, "Conversation already linked to another report")
        conversation = existing or Conversation(
            report_id=code.report_id, channel=body.channel, external_id=body.external_id
        )
        db.add(conversation)
        code.consumed_at = now()
        db.commit()
        return conversation

    @app.get(
        "/internal/conversations/{conversation_id}/snapshot",
        response_model=Snapshot,
        dependencies=internal,
    )
    def conversation_snapshot(conversation_id: UUID, db: Session = Depends(get_db)):
        conversation = linked_conversation(db, conversation_id)
        return snapshot(db, find_report(db, conversation.report_id))

    @app.post(
        "/internal/conversations/{conversation_id}/clarification",
        response_model=Snapshot,
        dependencies=internal,
    )
    def clarify(
        conversation_id: UUID, body: Clarification, db: Session = Depends(get_db)
    ):
        conversation = linked_conversation(db, conversation_id, mutation=True)
        report = apply_clarification(
            db,
            conversation.report_id,
            body,
            duplicate_radius_meters=settings.duplicate_radius_meters,
        )
        db.commit()
        return snapshot(db, report)

    @app.post(
        "/internal/conversations/{conversation_id}/recheck",
        response_model=Snapshot,
        dependencies=internal,
    )
    def recheck(conversation_id: UUID, body: Recheck, db: Session = Depends(get_db)):
        conversation = linked_conversation(db, conversation_id, mutation=True)
        report = find_report(db, conversation.report_id)
        apply_recheck(db, report, body)
        db.commit()
        return snapshot(db, report)

    @app.post(
        "/internal/conversations/resolve",
        response_model=ConversationView,
        dependencies=internal,
    )
    def resolve_conversation(body: ConversationLookup, db: Session = Depends(get_db)):
        conversations = list(
            db.scalars(
                select(Conversation).where(
                    Conversation.channel == body.channel,
                    Conversation.external_id == body.external_id,
                    Conversation.active.is_(True),
                )
            )
        )
        if not conversations:
            raise HTTPException(404, "Conversation not linked")
        if len(conversations) != 1:
            raise HTTPException(409, "Select a report through the messaging thread")
        return conversations[0]

    @app.post(
        "/internal/conversations/{conversation_id}/followup",
        response_model=TaskView,
        status_code=202,
        dependencies=internal,
    )
    def followup(
        conversation_id: UUID, body: IncomingFollowup, db: Session = Depends(get_db)
    ):
        if not body.text.strip():
            raise HTTPException(422, "Message text must not be blank")
        linked_conversation(db, conversation_id, mutation=True)
        key = digest(str(conversation_id) + ":" + body.message_id)
        task = enqueue(
            db,
            "followup",
            "followup:" + key,
            {"conversation_id": str(conversation_id), **body.model_dump()},
        )
        previous = db.scalar(
            select(ConversationMessage).where(
                ConversationMessage.conversation_id == conversation_id,
                ConversationMessage.direction == "inbound",
                ConversationMessage.provider_message_id == body.message_id,
            )
        )
        if previous is None:
            db.add(
                ConversationMessage(
                    conversation_id=conversation_id,
                    direction="inbound",
                    provider_message_id=body.message_id,
                    body=body.text,
                )
            )
        elif previous.body != body.text:
            raise HTTPException(409, "Message ID already used with different text")
        db.commit()
        return task

    def outgoing_view(db, row):
        return OutgoingView(
            id=row.id,
            event_id=row.event_id,
            conversation=ConversationView.model_validate(
                linked_conversation(db, row.conversation_id)
            ),
            payload=row.payload,
            attempts=row.attempts,
            lease_id=row.lease_id,
            leased_until=row.leased_until,
        )

    @app.post(
        "/internal/outgoing-messages/claim",
        response_model=list[OutgoingView],
        dependencies=internal,
    )
    def claim_messages(body: ClaimMessages, db: Session = Depends(get_db)):
        rows = list(
            db.scalars(
                select(OutgoingMessage)
                .join(Conversation, Conversation.id == OutgoingMessage.conversation_id)
                .outerjoin(
                    MessagingThread, MessagingThread.id == Conversation.thread_id
                )
                .where(
                    Conversation.active.is_(True),
                    MessagingThread.pilot_id.is_(None),
                    OutgoingMessage.delivered_at.is_(None),
                    OutgoingMessage.next_attempt_at <= now(),
                    or_(
                        OutgoingMessage.leased_until.is_(None),
                        OutgoingMessage.leased_until < now(),
                    ),
                )
                .order_by(OutgoingMessage.created_at, OutgoingMessage.id)
                .with_for_update(of=OutgoingMessage, skip_locked=True)
                .limit(body.limit)
            )
        )
        for row in rows:
            row.lease_id = uuid4()
            row.leased_until = now() + timedelta(minutes=2)
            row.attempts += 1
        db.commit()
        return [outgoing_view(db, row) for row in rows]

    def leased_message(db, message_id, lease_id):
        row = db.get(OutgoingMessage, message_id)
        if row is None:
            raise HTTPException(404, "Message not found")
        if row.lease_id != lease_id:
            raise HTTPException(409, "Delivery lease changed")
        return row

    @app.post(
        "/internal/outgoing-messages/{message_id}/delivered",
        response_model=DeliveryStatus,
        dependencies=internal,
    )
    def message_delivered(
        message_id: UUID, body: DeliveryAck, db: Session = Depends(get_db)
    ):
        if not body.sent_text.strip():
            raise HTTPException(422, "Sent text must not be blank")
        row = leased_message(db, message_id, body.lease_id)
        previous = db.scalar(
            select(ConversationMessage).where(
                ConversationMessage.outgoing_message_id == message_id
            )
        )
        if previous and (
            previous.body != body.sent_text
            or previous.provider_message_id != body.provider_message_id
        ):
            raise HTTPException(
                409, "Delivery acknowledgement already recorded with different content"
            )
        if row.delivered_at is None:
            row.delivered_at = now()
            row.leased_until = None
            row.last_error = None
        if previous is None:
            db.add(
                ConversationMessage(
                    conversation_id=row.conversation_id,
                    direction="outbound",
                    body=body.sent_text,
                    provider_message_id=body.provider_message_id,
                    outgoing_message_id=row.id,
                    created_at=row.delivered_at,
                )
            )
            db.commit()
        return row

    @app.post(
        "/internal/outgoing-messages/{message_id}/failed",
        response_model=DeliveryStatus,
        dependencies=internal,
    )
    def message_failed(
        message_id: UUID, body: DeliveryFailure, db: Session = Depends(get_db)
    ):
        row = leased_message(db, message_id, body.lease_id)
        if row.delivered_at:
            raise HTTPException(409, "Message already delivered")
        row.next_attempt_at = now() + timedelta(seconds=body.retry_after_seconds)
        row.leased_until = None
        row.lease_id = None
        row.last_error = "transport_failed"
        db.commit()
        return row

    @app.get(
        "/internal/agent/reports/{report_id}/snapshot",
        response_model=Snapshot,
        dependencies=[Depends(agent_access)],
    )
    def agent_snapshot(report_id: UUID, db: Session = Depends(get_db)):
        return snapshot(db, find_report(db, report_id))

    @app.get(
        "/internal/agent/reports/{report_id}/nearby",
        response_model=list[Snapshot],
        dependencies=[Depends(agent_access)],
    )
    def agent_nearby(report_id: UUID, db: Session = Depends(get_db)):
        from api.worker import nearby_snapshots

        return nearby_snapshots(db, find_report(db, report_id))

    return app


app = create_app()

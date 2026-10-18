import { expect, test, type Page } from "@playwright/test";

const rid = "10000000-0000-4000-8000-000000000001",
  cid = "30000000-0000-4000-8000-000000000001",
  jid = "20000000-0000-4000-8000-000000000001",
  uid = "60000000-0000-4000-8000-000000000002";
const at = new Date().toISOString();
const report = {
  id: rid,
  public_reference: "WG-A1B2C3D4E5F6",
  title: "Original fixture caption",
  note: "Fixture evidence retained exactly.",
  address: "Fixture park entrance",
  state: "needs_review",
  display_status: "needs_review",
  dashboard_status: "needs_review",
  location: { latitude: 24.92, longitude: 67.09, landmark: "Park gate" },
  photo_id: "photo",
  completion_photo_ids: [],
  job_id: null,
  version: 2,
  illustrative: false,
  created_at: at,
  updated_at: at,
  latest_update: null,
  clarifications: [],
  needs_review: true,
  priority: "medium",
  priority_reason: "Organiser review required",
  assessment_status: "assessed",
  assessment: {
    description: "Waste near a park gate",
    size: "small",
    obstruction: "walkway",
    obstruction_level: "partial",
    forces_people_into_traffic: "no",
    special_handling: "none_identified",
    visible_fire: "no",
    visible_sharp_objects: "unknown",
    confidence: 0.8,
    resident_context_agreement: "not_provided",
    comparison_reason: null,
    reason: "Review uncertain sharp objects",
  },
  triage: null,
  resident_answers: { fire: null, sharp_objects: null },
};
const job = {
  id: jid,
  category: "litter",
  status: "unassigned",
  location: report.location,
  priority: "medium",
  required_equipment: ["gloves"],
  estimated_service_minutes: 5,
  assigned_crew_id: null,
  locked: false,
  held: false,
  route_position: null,
  travel_minutes: 0,
  decision_summary: "Fixture approved job",
  unassigned_reason: null,
  version: 1,
  illustrative: false,
  eligible: true,
  eligibility_reasons: [],
  public_references: [report.public_reference],
  address: report.address,
  photo_id: "photo",
};
const crew = {
  id: cid,
  name: "Pilot Crew",
  equipment: ["gloves", "trash_bags"],
  shift_minutes: 120,
  available: true,
  start_location: report.location,
  illustrative: false,
  location_recorded_at: at,
  location_received_at: at,
  location_revision: 1,
};
const preview = {
  id: "40000000-0000-4000-8000-000000000001",
  job_ids: [jid],
  computed_at: at,
  expires_at: new Date(Date.now() + 120000).toISOString(),
  matrix_id: "fixture",
  travel_label: "OSRM road estimates; no live traffic",
  routes: [
    {
      crew_id: cid,
      stops: [
        {
          job_id: jid,
          position: 0,
          priority: "medium",
          travel_minutes: 4,
          service_minutes: 5,
          completion_minutes: 9,
          fixed: false,
          service_estimate_source: "fixed_collection_time",
        },
      ],
      duration_minutes: 13,
      travel_minutes: 8,
      return_travel_minutes: 4,
      returns_to_start: true,
    },
  ],
  unassigned: [],
  exclusions: [],
  metrics: { weighted_wait: 18, latest_finish: 13, total_travel: 8, score: 33 },
  termination_reason: "local_optimum",
  dispatchable: true,
  reassignments: [
    {
      job_id: jid,
      previous_crew_id: null,
      previous_position: null,
      proposed_crew_id: cid,
      proposed_position: 0,
    },
  ],
  settings: {
    constraints: {
      max_duration_minutes: 120,
      max_stops_per_crew: 10,
      return_to_start: true,
      allow_partial: false,
    },
  },
  plan_id: null as string | null,
  dispatch_receipt: null as unknown,
};

async function fixtures(page: Page) {
  let command = "";
  let decision: Record<string, unknown> | null = null;
  let completed = false;
  let decisionCalls = 0;
  await page.route("https://auth.fixture.test/**", async (route) =>
    route.fulfill({
      json: {
        access_token: "fixture-access",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "fixture-refresh",
        user: {
          id: uid,
          aud: "authenticated",
          role: "authenticated",
          email: "organizer@example.com",
        },
      },
    }),
  );
  await page.route("https://api.fixture.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().headers().authorization).toBe("Bearer fixture-access");
    const currentReport = {
      ...report,
      state: decision ? "linked_to_job" : report.state,
      display_status: completed ? "completed" : command ? "assigned" : decision ? "unassigned" : report.display_status,
      dashboard_status: completed ? "resolved" : command ? "in-progress" : "submitted",
      needs_review: !decision,
      job_id: decision ? jid : null,
      version: decision ? 3 : report.version,
      triage: decision,
      completion_photo_ids: completed ? ["completion-photo"] : [],
    };
    const currentJob = { ...job, status: completed ? "completed" : command ? "assigned" : "unassigned", assigned_crew_id: command ? cid : null, route_position: command ? 0 : null };
    let data: unknown;
    if (path === "/auth/me")
      data = { user_id: uid, role: "organizer", crew_id: null };
    else if (path === "/organizer/overview")
      data = {
        counts: {
          needs_review: decision ? 0 : 1,
          high_priority_jobs: 0,
          in_progress_jobs: 0,
          available_crews: 1,
          blocked_jobs: 0,
          completed_24h: completed ? 1 : 0,
          awaiting_assessment: 0,
        },
        include_illustrative: false,
        configuration: {
          revision: "f".repeat(40),
          organizer_routing_enabled: true,
          road_service_configured: true,
          messaging_pilot_enabled: false,
        },
        processing: {
          run_id: null,
          status: "inactive",
          reason: null,
          starts_at: null,
          expires_at: null,
          model: null,
          used_attempts: 0,
          max_attempts: 4,
          new_reports_admitted: 0,
          max_new_reports: 2,
          worker_online: false,
          last_heartbeat_at: null,
          last_success_at: null,
          queue: { pending: 0, running: 0, succeeded: 0, failed: 0 },
        },
      };
    else if (path === "/organizer/report-index")
      data = {
        items: [
          {
            ...currentReport,
            title: "Litter · WG-A1B2C3D4E5F6",
            category: "litter",
            crew_id: command ? cid : null,
            crew_name: command ? crew.name : null,
            route_position: command ? 0 : null,
            job_status: decision ? currentJob.status : null,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      };
    else if (path === `/organizer/reports/${rid}/decision`) {
      const body = route.request().postDataJSON();
      expect(route.request().method()).toBe("POST");
      expect(body).toMatchObject({ report_id: rid, expected_version: 2, next_action: "create_job", category: "litter", evidence_sufficient: true, proposed_equipment: ["gloves"], estimated_service_minutes: 5, evidence_report_ids: [rid] });
      expect(body.command_id).toMatch(/^[0-9a-f-]{36}$/);
      decision = body;
      decisionCalls++;
      data = { ...currentReport, state: "linked_to_job", display_status: "unassigned", needs_review: false, job_id: jid, version: 3, triage: decision };
    }
    else if (path === `/organizer/reports/${rid}`)
      data = {
        report: currentReport,
        events: [
          {
            id: "event",
            kind: "report.received",
            actor: "resident",
            created_at: at,
            details: {},
          },
        ],
        processing: {
          assessment: { status: "succeeded", attempts: 1, error_code: null },
          triage: null,
          demo_run_id: null,
        },
      };
    else if (path.startsWith("/photos/"))
      data = { url: path.includes("completion-photo") ? "https://photo.fixture.test/after.svg" : "https://photo.fixture.test/image.svg" };
    else if (path === "/crews") data = [crew];
    else if (path === "/organizer/job-index")
      data = { items: decision && !completed ? [currentJob] : [], total: decision && !completed ? 1 : 0, limit: 100, offset: 0 };
    else if (path === `/jobs/${jid}`) {
      expect(decision).not.toBeNull();
      data = { job: currentJob, photo_ids: ["photo"], events: [] };
    }
    else if (path === "/plans/current") data = { plan: null };
    else if (path.endsWith("/dispatch")) {
      expect(decisionCalls).toBe(1);
      expect(decision).not.toBeNull();
      command = route.request().postDataJSON().command_id;
      data = { preview_id: preview.id, plan_id: "fixture-plan" };
    } else if (path.includes("/geometry/"))
      data = {
        status: "ready",
        geometry: {
          type: "LineString",
          coordinates: [
            [67.09, 24.92],
            [67.095, 24.925],
            [67.09, 24.92],
          ],
        },
        retry_after_seconds: null,
      };
    else if (path.startsWith("/routing/previews")) {
      if (route.request().method() === "POST") {
        expect(decisionCalls).toBe(1);
        expect(route.request().postDataJSON()).toMatchObject({ crew_ids: [cid], job_ids: [jid] });
      }
      data = {
        ...preview,
        plan_id: command ? "fixture-plan" : null,
        dispatch_receipt: command
          ? {
              command_id: command,
              actor_id: uid,
              plan_id: "fixture-plan",
              accept_partial: false,
            }
          : null,
      };
    }
    else
      return route.fulfill({
        status: 404,
        json: { detail: "Fixture endpoint not defined" },
      });
    return route.fulfill({ json: data });
  });
  await page.route("https://photo.fixture.test/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#dcece4"/><text x="40" y="200" font-size="32" fill="#12804d">Fixture report evidence</text></svg>',
    }),
  );
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  return {
    completeCleanup() {
      // Simulates the server update from the Android crew app, not a live integration.
      expect(command).not.toBe("");
      completed = true;
    },
  };
}

test("fixture walkthrough approves a report, dispatches its job, and displays simulated crew evidence", async ({
  page,
}, testInfo) => {
  const backend = await fixtures(page);
  const capture = async (name: string) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/report/new");
  await expect(page.getByRole("heading", { name: "Residents and crews" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("organizer@example.com");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Every report. A clearer next step." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await capture("overview.png");
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/reports$/);
  await page
    .getByRole("link", { name: "WG-A1B2C3D4E5F6", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /WG-A1B2C3D4E5F6/ }),
  ).toBeVisible();
  await expect(
    page.getByText("Fixture evidence retained exactly.", { exact: true }),
  ).toBeVisible();
  await capture("report-review.png");
  await page.getByLabel("Category", { exact: true }).fill("litter");
  await page.getByRole("checkbox", { name: "Gloves", exact: true }).check();
  await page.getByRole("checkbox", { name: "Evidence sufficient", exact: true }).check();
  await page.getByLabel("Decision summary", { exact: true }).fill("Fixture organizer approves collection after reviewing evidence.");
  await page.getByRole("combobox", { name: "Next action", exact: true }).selectOption("create_job");
  await page.getByLabel("Estimated service minutes", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Review decision", exact: true }).click();
  await page.getByRole("button", { name: "Apply organiser decision", exact: true }).click();
  await expect(page.getByRole("region", { name: "Linked job", exact: true })).toContainText(jid);
  await expect(page.getByText("This report is already linked to a job. Its priority can be reviewed separately.")).toBeVisible();
  await capture("report-approved.png");
  await page.getByRole("link", { name: "Routing dispatch" }).click();
  await expect(
    page.getByRole("heading", { name: "Routing workspace" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(`Select Pilot Crew`) })
    .click();
  await page
    .getByRole("button", { name: new RegExp(`Select job litter`) })
    .click();
  await page.getByRole("button", { name: "Compute route preview" }).click();
  await expect(
    page.getByRole("heading", { name: "Preview for review" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review dispatch", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and dispatch" }).click();
  await expect(
    page.getByRole("heading", { name: "Dispatch confirmed" }),
  ).toBeVisible();
  await capture("routing-committed.png");
  backend.completeCleanup();
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await page.getByRole("link", { name: report.public_reference, exact: true }).click();
  const evidence = page.getByRole("region", { name: "Cleanup evidence", exact: true });
  await expect(evidence).toContainText("Crew reported complete");
  await evidence.scrollIntoViewIfNeeded();
  await expect(evidence.getByAltText("Cleanup completion photo 1")).toBeVisible();
  await expect(evidence.getByAltText("Cleanup completion photo 1")).toHaveAttribute("src", "https://photo.fixture.test/after.svg");
  await capture("cleanup-evidence.png");
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

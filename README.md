<p align="center">
  <img src="web/public/brand/wastegrid-icon.png" alt="WasteGrid logo" width="96" />
</p>

# WasteGrid

### From reported waste to coordinated cleanup.

WasteGrid connects the person who spots waste with the people who can clear it.
A resident takes a photo, an organizer reviews the situation and plans a response,
and a crew carries out the cleanup. The resident can then follow what happened to
the report they submitted.

**One connected journey: report → assess → coordinate → collect → follow up.**

[Explore the demo](docs/demo.md) · [How we built it](#how-we-built-it) ·
[Run it locally](docs/development.md#getting-started)

![WasteGrid organizer console showing report activity, review work, and crew readiness](docs/images/organizer-overview.png)

*The organizer console, shown with illustrative demo data.*

## Why we built it

Spotting dumped waste is easy. Coordinating a response takes more: a usable
location, an understanding of urgency, the right equipment, an available crew,
and a way to tell the resident what happened.

We built WasteGrid to bring those decisions together. Residents get a clear way
to report a problem and follow its progress. Organizers get the context to act.
Crews get a practical route and a clear next stop.

## The experience

1. **See it. Report it.** A resident captures a photo, adds a caption, and confirms
   the location with GPS or a map pin. The app saves their report so an interrupted
   upload can be recovered.
2. **Understand what needs attention.** Photo analysis identifies visible conditions.
   Backend rules calculate priority, while hazards, uncertainty, and possible
   duplicates go to organizer review.
3. **Turn reports into a response.** The organizer reviews the evidence, selects
   jobs and crews, and previews routes using road travel times, equipment needs,
   and available capacity. They approve the plan before anyone is dispatched.
4. **Give crews a clear next step.** Crews see their ordered stops on mobile,
   start a job, and report completion, optionally adding a cleanup photo.
5. **Bring the update back.** The resident sees the report's progress, history,
   and any submitted cleanup photos. With phone updates enabled, typing **Status**
   also returns an in-app reply and sends a copy to the registered phone.

## What makes the build distinctive

- **AI with a clear role.** The model helps interpret the photo; explicit rules
  determine priority, and organizers retain control over review and dispatch.
- **Planning around real work.** Routes account for roads, equipment, crew capacity,
  and work already underway. Organizers can inspect what fits, what remains
  unassigned, and why before approving a plan.
- **Continuity when connections fail.** Saved uploads and recoverable actions
  protect the same report and dispatch from being duplicated after a lost response.
- **A visible outcome for the resident.** Reporting, collection, and follow-up share
  the same case history. Completion stays labeled as crew-reported, with photos
  shown when they were actually submitted.

## How we built it

| Part of the experience | What powers it |
| --- | --- |
| Resident and crew app | **Expo + React Native** for photo capture, location, reporting, and crew execution. |
| Organizer console | **React + Leaflet** for report review, operational views, route maps, and dispatch. |
| Photo understanding | **Chalk Model Gateway** for structured vision output, validated before Python priority rules use it. |
| Cleanup planning | **OSRM road travel times + a custom routing heuristic**, balancing priority, resources, and route constraints. |
| Shared case history | **FastAPI + Supabase** for reports, private photos, staff roles, assignments, and updates. |
| Phone updates | **Photon** for consented iMessage copies and delivery tracking in the supervised messaging flow. |

The engineering challenge was keeping the whole journey consistent: a report
must remain the same report through AI assessment, human review, route changes,
crew execution, and retries. The implementation preserves that connection across
the mobile app, browser console, and backend.

## Follow the demo

The hackathon walkthrough follows **one report from submission to resident-visible
completion**. Residents and crews use the Android app; the organizer uses the
browser console. A single phone can demonstrate both roles by switching accounts
while keeping the original report.

Start with the [product walkthrough](docs/demo.md). The
[one-phone demo guide](docs/backend/hackathon-finish.md) covers the complete sequence
and the configured assessment session.

This is a supervised prototype. Assessment and phone messaging need their configured
services, and cleanup completion is reported by the crew. Citywide deployment and
measured environmental impact are future validation work.

## Explore the project

- [Mobile app](mobile/README.md): resident reporting, crew routes, and account roles.
- [Organizer console](web/README.md): review, maps, and dispatch.
- [Development guide](docs/development.md): local setup, architecture, tests, and deployment.
- [Documentation index](docs/README.md): backend contracts, routing, assessment, and messaging.

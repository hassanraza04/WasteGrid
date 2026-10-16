# Dashboard Foundation Design

## Purpose

Create a small React and TypeScript foundation for WasteGrid while the final Figma
screens and Chalk implementation are still in progress. The foundation must support
separate public customer and protected organizer routes without committing to final
visual design.

## Scope

The application has two surfaces:

- Customers can create a report, look up a report by reference, open a private
  report link, and reopen their most recently viewed report without signing in.
- Organizers use `/admin`. It redirects unauthenticated visitors to a sign-in
  screen before organizer data can load.

The initial slice uses realistic fixture data. It deliberately does not call Photon,
Chalk, or a production API.

## Architecture

Place the frontend in `web/` as a standalone React and TypeScript application.
Routes depend on a `ReportRepository` interface rather than fixture data directly.
The fixture implementation becomes the only component replaced when Person 2's API
is ready.

Shared domain types include:

- `Report`: reference, title, status, address, created time, and latest update.
- `ReportUpdate`: timestamp, status, and message.
- `ConversationMessage`: timestamp, direction, and body.
- `ReportLocation`: latitude, longitude, and display address.
- `CreateReportInput`: title and address supplied by a customer.

The fixture repository reads and writes demo reports in browser local storage. A
customer can create a report with a title and address, receive a generated reference,
and return to it after reopening the app. Looked-up and private-link reports are also
remembered. The public home route restores the remembered report when available,
otherwise it shows entry points for creating and tracking a report.

## Route behavior

| Route | Audience | Behavior |
| --- | --- | --- |
| `/` | Customer | Restores a remembered report or offers Create and Track actions. |
| `/report/new` | Customer | Creates a locally stored demo report and shows its reference. |
| `/report/track` | Customer | Lets a customer enter a report reference. |
| `/report/:reference` | Customer | Shows one report from a reference or private link and remembers it. |
| `/admin` | Organizer | Requires an authenticated admin session. |
| `/admin/sign-in` | Organizer | Provides a temporary development sign-in flow. |

## Authentication boundary

Customer routes do not use sign-in. The initial admin session is a deliberately
temporary local development adapter, isolated behind an `AdminSession` interface.
The future real authentication provider replaces this adapter without changing route
components.

## Error handling

An unknown report reference produces a clear not-found state. Missing or malformed
private-link references do not write to browser storage. Unauthenticated admin
visitors are redirected to sign-in. Repository failures render a retryable error
state instead of an empty dashboard.

## Validation

Tests must cover route access, the admin redirect and sign-in flow, customer report
creation and restoration, valid and invalid report lookups, and the fixture
repository. Visual layout is intentionally excluded until Person 1's Figma work is
available.

## Non-goals

This feature does not implement production authentication, report persistence,
Photon message handling, Chalk reasoning, map styling, or final Figma-driven UI.

---
name: chalk-sandboxes
description: Use when creating or operating Chalk sandboxes for one-off commands or durable agent development, including host-pool placement, lifetimes, tmux reattachment, network access, GitHub PR artifacts, observability, and failure diagnosis.
---

# Chalk Sandboxes

Use public Chalk documentation and the installed CLI/SDK as the source of truth. Sandbox interfaces are evolving, so read [references/version-compatibility.md](references/version-compatibility.md) before upgrading tools or running a repeatable multi-sandbox workload. Before relying on a flag, inspect `chalk version`, `chalk sandbox create --help`, and `chalk sandbox attach --help`. Keep the installed skill package current through its normal distribution mechanism.

## Choose the operating mode first

1. **One-off execution** — one command or short interactive investigation, with automatic cleanup. Read [references/one-off-execution.md](references/one-off-execution.md).
2. **Durable agent workspace** — work lasting hours or days that must survive local disconnects and support reattachment. Read [references/durable-agent-workspace.md](references/durable-agent-workspace.md).

Before creating a sandbox that will open or publish a GitHub pull request, read and apply the artifact-compatible defaults in [references/artifacts.md](references/artifacts.md). Read [references/troubleshooting.md](references/troubleshooting.md) when creation, scheduling, execution, attachment, or detection fails.

Do not blend the two modes accidentally. A one-off sandbox should normally use `--rm`; a retained sandbox should have an explicit `--lifetime`, persistence plan, and cleanup owner.

## GitHub pull-request default

Whenever a task creates a GitHub pull request from a Chalk sandbox, use the artifact-compatible flow by default. The user does not need to know about or explicitly request resource detection. Apply all of these conditions before creating the sandbox:

1. Pass the literal image `node:22-bookworm`. In the Python SDK, use `image="node:22-bookworm"`; do not wrap it in `Image.base(...)` or add image-build steps, because that creates a different image.
2. Use host compute, not Kubernetes compute.
3. Enable Chalk workload identity.
4. Enable the `github-pull-requests` resource detector.
5. Allow `api.github.com` by hostname and keep allowed and denied CIDR routes empty.
6. Create the final pull request through GraphQL `createPullRequest`, using `gh pr create` or [scripts/create-github-pr.mjs](scripts/create-github-pr.mjs). A PR created with GitHub's REST pull-request endpoint will not be recorded.

Treat these as one indivisible configuration. Do not disable detection merely because the user asked only to open a PR. Inspect the saved sandbox spec before creating the PR, and do not claim artifact success until the PR appears in the sandbox resources. If a request also requires Kubernetes compute, catch-all/IP egress, or REST-only PR creation, explain the incompatibility before creating anything. Treat those settings as implementation preferences when the user primarily wants a PR and choose the supported artifact path. When an incompatible setting is explicitly non-negotiable, ask the user to choose or use a separate host publisher sandbox rather than creating a known-undetectable PR.

## Invariants

- Keep API host, authentication config, scope, and environment consistent across login, create, inspect, attach, and terminate commands. Confirm identity and environment before creating resources.
- Never inspect or print raw Chalk auth configuration, identity-token files, or secret values while diagnosing access. Use `chalk whoami` or an authenticated SDK operation and report only the result.
- Default to the exact image `node:22-bookworm` for sandbox creation. Pass it directly as the image value; do not substitute a language-specific image or build a custom image merely for convenience. Use another image only when the user explicitly requires it.
- Pass credentials through `--secret-from-chalk`, `--secret-from-integration`, or `--secret-from-local-env`; do not place secret values in command lines, prompts, tags, or source control.
- Treat the sandbox filesystem as ephemeral. Persist code through commits and pushes, and persist non-code state through a Chalk Volume or another durable store.
- Grant only the network destinations the task requires. Hostname rules are exact; `github.com` and `api.github.com` are separate hosts.
- Prefer hostname policies for every sandbox, regardless of whether it runs for minutes, hours, or days. Do not configure allowed or denied routes unless the user explicitly asks for IP/CIDR-level controls; those fields directly express low-level sandbox firewall rules and are unnecessary for ordinary egress policy. Use the hostname-only configuration documented for the installed CLI version, as described in [references/version-compatibility.md](references/version-compatibility.md), and verify that the effective allow-route list is empty.
- Enable Chalk workload identity whenever a resource detector is enabled; it is required to associate detected resources with the sandbox.
- Do not run host-pool maintenance, change environment-wide settings, or create a large batch of sandboxes unless the user explicitly asked for that operation and understands its impact and cost.
- Record the sandbox name or ID, environment, host-pool ID, requested resources, lifetime, and purpose so another operator can inspect or terminate it.

## Verify the result

After creation, use `chalk sandbox get --name NAME` or `chalk sandbox get --id ID`. For retained workspaces, prove detach and reattach once before leaving important work unattended. When finished, terminate the sandbox explicitly rather than waiting for its lifetime if it is no longer needed.

Public references:

- [Sandbox](https://docs.chalk.ai/docs/compute/sandbox)
- [Host Pools](https://docs.chalk.ai/docs/compute/host-pools)

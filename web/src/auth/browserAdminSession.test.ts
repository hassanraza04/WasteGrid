import { beforeEach, expect, test } from "vitest";

import { BrowserAdminSession } from "./browserAdminSession";

beforeEach(() => {
  window.localStorage.clear();
});

test("starts signed out and remains signed in after a new instance is created", () => {
  const first = new BrowserAdminSession(window.localStorage);
  expect(first.isSignedIn()).toBe(false);

  first.signIn();

  const second = new BrowserAdminSession(window.localStorage);
  expect(second.isSignedIn()).toBe(true);
});

test("signs out by removing the local session", () => {
  const session = new BrowserAdminSession(window.localStorage);
  session.signIn();
  session.signOut();

  expect(session.isSignedIn()).toBe(false);
});

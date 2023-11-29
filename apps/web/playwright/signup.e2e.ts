import { expect } from "@playwright/test";
import { randomBytes } from "crypto";

import { APP_NAME, IS_PREMIUM_USERNAME_ENABLED, IS_MAILHOG_ENABLED } from "@calcom/lib/constants";

import { test } from "./lib/fixtures";
import { getEmailsReceivedByUser } from "./lib/testUtils";

test.describe.configure({ mode: "parallel" });

test.describe("Signup Flow Test", async () => {
  test.beforeEach(async ({ features }) => {
    features.reset(); // This resets to the inital state not an empt yarray
  });
  test.afterAll(async ({ users }) => {
    await users.deleteAll();
  });
  test("Username is taken", async ({ page, users }) => {
    // log in trail user
    await test.step("Sign up", async () => {
      await users.create({
        username: "pro",
      });

      await page.goto("/signup");

      const alertMessage = "Username or email is already taken";

      // Fill form
      await page.locator('input[name="username"]').fill("pro");
      await page.locator('input[name="email"]').fill("pro@example.com");
      await page.locator('input[name="password"]').fill("Password99!");

      // Submit form
      await page.click('button[type="submit"]');

      const alert = await page.waitForSelector('[data-testid="alert"]');
      const alertMessageInner = await alert.innerText();

      expect(alertMessage).toBeDefined();
      expect(alertMessageInner).toContain(alertMessageInner);
    });
  });
  test("Email is taken", async ({ page, users }) => {
    // log in trail user
    await test.step("Sign up", async () => {
      const user = await users.create({
        username: "pro",
      });

      await page.goto("/signup");

      const alertMessage = "Username or email is already taken";

      // Fill form
      await page.locator('input[name="username"]').fill("randomuserwhodoesntexist");
      await page.locator('input[name="email"]').fill(user.email);
      await page.locator('input[name="password"]').fill("Password99!");

      // Submit form

      await page.click('button[type="submit"]');
      const alert = await page.waitForSelector('[data-testid="alert"]');
      const alertMessageInner = await alert.innerText();

      expect(alertMessage).toBeDefined();
      expect(alertMessageInner).toContain(alertMessageInner);
    });
  });
  test("Premium Username Flow - creates stripe checkout", async ({ page, users, prisma }) => {
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip(!IS_PREMIUM_USERNAME_ENABLED, "Only run on Cal.com");
    const userToCreate = users.buildForSignup({
      username: "rock",
      password: "Password99!",
    });
    // Ensure the premium username is available
    await prisma.user.deleteMany({ where: { username: "rock" } });

    // Signup with premium username name
    await page.goto("/signup");

    // Fill form
    await page.locator('input[name="username"]').fill("rock");
    await page.locator('input[name="email"]').fill(userToCreate.email);
    await page.locator('input[name="password"]').fill(userToCreate.password);

    await page.click('button[type="submit"]');

    // Check that stripe checkout is present
    const expectedUrl = "https://checkout.stripe.com";

    await page.waitForURL((url) => url.href.startsWith(expectedUrl));
    const url = page.url();

    // Check that the URL matches the expected URL
    expect(url).toContain(expectedUrl);
    // TODO: complete the stripe checkout flow
  });
  test("Signup with valid (non premium) username", async ({ page, users, features }) => {
    const userToCreate = users.buildForSignup({
      username: "rick-jones",
      password: "Password99!",
    });

    await page.goto("/signup");

    // Fill form
    await page.locator('input[name="username"]').fill(userToCreate.username);
    await page.locator('input[name="email"]').fill(userToCreate.email);
    await page.locator('input[name="password"]').fill(userToCreate.password);

    await page.click('button[type="submit"]');
    await page.waitForLoadState("networkidle");
    // Find the newly created user and add it to the fixture store
    const newUser = await users.set(userToCreate.email);
    expect(newUser).not.toBeNull();

    // Check that the URL matches the expected URL
    expect(page.url()).toContain("/auth/verify-email");
  });
  test("Signup fields prefilled with query params", async ({ page, users }) => {
    const signupUrlWithParams = "/signup?username=rick-jones&email=rick-jones%40example.com";
    await page.goto(signupUrlWithParams);

    // Fill form
    const usernameInput = page.locator('input[name="username"]');
    const emailInput = page.locator('input[name="email"]');

    expect(await usernameInput.inputValue()).toBe("rick-jones");
    expect(await emailInput.inputValue()).toBe("rick-jones@example.com");
  });
  test("Signup with token prefils correct fields", async ({ page, users, prisma }) => {
    //Create a user and create a token
    const token = randomBytes(32).toString("hex");
    const userToCreate = users.buildForSignup({
      username: "rick-team",
    });

    const createdtoken = await prisma.verificationToken.create({
      data: {
        identifier: userToCreate.email,
        token,
        expires: new Date(new Date().setHours(168)), // +1 week
        team: {
          create: {
            name: "Rick's Team",
            slug: `${userToCreate.username}-team`,
          },
        },
      },
    });

    // create a user with the same email as the token
    const rickTeamUser = await prisma.user.create({
      data: {
        email: userToCreate.email,
        username: userToCreate.username,
      },
    });

    // Create provitional membership
    await prisma.membership.create({
      data: {
        teamId: createdtoken.teamId ?? -1,
        userId: rickTeamUser.id,
        role: "ADMIN",
        accepted: false,
      },
    });

    const signupUrlWithToken = `/signup?token=${token}`;

    await page.goto(signupUrlWithToken);

    const usernameField = page.locator('input[name="username"]');
    const emailField = page.locator('input[name="email"]');

    expect(await usernameField.inputValue()).toBe(userToCreate.username);
    expect(await emailField.inputValue()).toBe(userToCreate.email);

    // Cleanup specific to this test
    // Clean up the user and token
    await prisma.user.deleteMany({ where: { email: userToCreate.email } });
    await prisma.verificationToken.deleteMany({ where: { identifier: createdtoken.identifier } });
    await prisma.team.deleteMany({ where: { id: createdtoken.teamId! } });
  });
  test("Email verification sent if enabled", async ({ page, prisma, emails, users, features }) => {
    const EmailVerifyFlag = features.get("email-verification")?.enabled;

    // eslint-disable-next-line playwright/no-skipped-test
    test.skip(!EmailVerifyFlag || !IS_MAILHOG_ENABLED, "Skipping check - Email verify disabled");
    // Ensure email verification before testing (TODO: this could break other tests but we can fix that later)
    await prisma.feature.update({
      where: { slug: "email-verification" },
      data: { enabled: true },
    });
    const userToCreate = users.buildForSignup({
      username: "email-verify",
      password: "Password99!",
    });

    await page.goto("/signup");

    // Fill form
    await page.locator('input[name="username"]').fill(userToCreate.username);
    await page.locator('input[name="email"]').fill(userToCreate.email);
    await page.locator('input[name="password"]').fill(userToCreate.password);

    await page.click('button[type="submit"]');

    await page.waitForURL((url) => url.pathname.includes("/auth/verify-email"));
    // Find the newly created user and add it to the fixture store
    const newUser = await users.set(userToCreate.email);
    expect(newUser).not.toBeNull();

    const receivedEmails = await getEmailsReceivedByUser({
      emails,
      userEmail: userToCreate.email,
    });

    // We need to wait for emails to be sent
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(5000);

    expect(receivedEmails?.total).toBe(1);

    const verifyEmail = receivedEmails?.items[0];
    expect(verifyEmail?.subject).toBe(`${APP_NAME}: Verify your account`);
  });
});

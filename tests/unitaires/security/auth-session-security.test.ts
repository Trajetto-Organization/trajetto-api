import { describe, expect, it } from "vitest";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import { LogoutUseCase } from "@/modules/user/usecases/logout/logout-usecase";

describe("auth and tenant security", () => {
  it("denies a non-master principal from another tenant", () => {
    expect(() =>
      assertTenantAccess(
        { role: "BUSINESS_ADMIN", businessId: "business-a" },
        "business-b",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "TENANT_ACCESS_DENIED",
        statusCode: 403,
      }),
    );
  });

  it("allows master access across tenants", () => {
    expect(() =>
      assertTenantAccess({ role: "MASTER", businessId: null }, "business-b"),
    ).not.toThrow();
  });

  it("rotates a refresh token only once", async () => {
    const repository = new InMemoryUserTokensRepository();
    const expires = new Date(Date.now() + 60_000);

    await repository.createUserRefreshToken({
      userId: "user-1",
      token_hash: "old-hash",
      jti: "old-jti",
      family_id: "family-1",
      expires_in: expires,
    });

    const replacement = {
      userId: "user-1",
      token_hash: "new-hash",
      jti: "new-jti",
      family_id: "family-1",
      expires_in: expires,
    };

    // No grace: the second presentation is a replay, whenever it comes.
    const firstRotation = await repository.rotateUserRefreshToken({
      user_id: "user-1",
      current_jti: "old-jti",
      current_token_hash: "old-hash",
      replacement,
      grace_ms: 0,
    });
    const replay = await repository.rotateUserRefreshToken({
      user_id: "user-1",
      current_jti: "old-jti",
      current_token_hash: "old-hash",
      replacement: { ...replacement, jti: "other-jti", token_hash: "other-hash" },
      grace_ms: 0,
    });

    expect(firstRotation.outcome).toBe("rotated");
    expect(
      firstRotation.outcome === "rotated" && firstRotation.token.jti,
    ).toBe("new-jti");
    expect(replay.outcome).toBe("reused");

    await expect(
      repository.hasActiveRefreshTokenFamily("user-1", "family-1"),
    ).resolves.toBe(true);
  });

  it("treats a second presentation inside the grace window as a race, not a replay", async () => {
    const repository = new InMemoryUserTokensRepository();
    const expires = new Date(Date.now() + 60_000);

    await repository.createUserRefreshToken({
      userId: "user-1",
      token_hash: "old-hash",
      jti: "old-jti",
      family_id: "family-1",
      expires_in: expires,
    });

    const rotate = (jti: string) =>
      repository.rotateUserRefreshToken({
        user_id: "user-1",
        current_jti: "old-jti",
        current_token_hash: "old-hash",
        replacement: {
          userId: "user-1",
          token_hash: `${jti}-hash`,
          jti,
          family_id: "family-1",
          expires_in: expires,
        },
        grace_ms: 60_000,
      });

    // Two tabs, one token.
    const first = await rotate("tab-1");
    const second = await rotate("tab-2");

    expect(first.outcome).toBe("rotated");
    expect(second.outcome).toBe("raced");

    // Both tabs hold a live token of the same session.
    const live = repository.refreshTokenItems.filter(
      (item) => item.family_id === "family-1" && !item.revoked_at,
    );

    expect(live.map((item) => item.jti).sort()).toEqual(["tab-1", "tab-2"]);
  });

  it("answers unknown, not reused, for a session that already ended", async () => {
    const repository = new InMemoryUserTokensRepository();

    const outcome = await repository.rotateUserRefreshToken({
      user_id: "user-1",
      current_jti: "logged-out-jti",
      current_token_hash: "logged-out-hash",
      replacement: {
        userId: "user-1",
        token_hash: "x",
        jti: "x",
        family_id: "family-1",
        expires_in: new Date(Date.now() + 60_000),
      },
      grace_ms: 60_000,
    });

    expect(outcome.outcome).toBe("unknown");
  });

  it("logs out only the current session family", async () => {
    const tokens = new InMemoryUserTokensRepository();
    const expires_in = new Date(Date.now() + 60_000);

    await tokens.createUserRefreshToken({
      userId: "user-1",
      token_hash: "hash-a",
      jti: "jti-a",
      family_id: "family-a",
      expires_in,
    });
    await tokens.createUserRefreshToken({
      userId: "user-1",
      token_hash: "hash-b",
      jti: "jti-b",
      family_id: "family-b",
      expires_in,
    });

    await new LogoutUseCase(tokens).execute("family-a");
    expect(await tokens.hasActiveRefreshTokenFamily("user-1", "family-a")).toBe(
      false,
    );

    expect(await tokens.hasActiveRefreshTokenFamily("user-1", "family-b")).toBe(
      true,
    );
  });

  it("cleans only expired refresh-token rows", async () => {
    const tokens = new InMemoryUserTokensRepository();
    const now = new Date();

    await tokens.createUserRefreshToken({
      userId: "user-1",
      token_hash: "expired-hash",
      jti: "expired-jti",
      family_id: "expired-family",
      expires_in: new Date(now.getTime() - 1),
    });

    await tokens.createUserRefreshToken({
      userId: "user-1",
      token_hash: "active-hash",
      jti: "active-jti",
      family_id: "active-family",
      expires_in: new Date(now.getTime() + 60_000),
    });

    await expect(tokens.deleteExpiredUserRefreshTokens(now)).resolves.toBe(1);
    await expect(
      tokens.hasActiveRefreshTokenFamily("user-1", "active-family"),
    ).resolves.toBe(true);
  });
});

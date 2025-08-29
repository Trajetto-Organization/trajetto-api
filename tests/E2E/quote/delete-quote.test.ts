import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { DeleteQuoteUseCase } from "@/modules/quote/usecases/delete-quote/delete-quote-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("Delete Quote E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = DeleteQuoteUseCase.prototype.execute;
  });

  afterEach(() => {
    DeleteQuoteUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to delete a quote", async () => {
    const quoteData = {
      name: "John Doe Customer",
      company: "Customer Company",
      email: "delete@example.com",
      telephone: "11987654321",
      fleet_size: "1-5",
    };

    const createQuote = await prisma.quote.create({
      data: quoteData,
    });

    const response = await request(serverInstance)
      .delete(`/quote/delete-quote/${createQuote.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("Orçamento deletado com sucesso!");
  });

  it("should throw QuoteNotFoundError if quote does not exist", async () => {
    const response = await request(serverInstance)
      .delete(`/quote/delete-quote/550e8400-e29b-41d4-a716-446655440000`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(404);
    expect(response.body.message).toBe("Orçamento não encontrado");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    DeleteQuoteUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .delete(`/quote/delete-quote/550e8400-e29b-41d4-a716-446655440001`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    DeleteQuoteUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .delete(`/quote/delete-quote/550e8400-e29b-41d4-a716-446655440002`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});

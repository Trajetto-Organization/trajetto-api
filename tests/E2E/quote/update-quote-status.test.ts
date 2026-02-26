import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { UpdateQuoteStatusUseCase } from "@/modules/quote/usecases/update-quote-status/update-quote-status-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;

let uniqueName: string;
let uniqueCompany: string;

let uniqueEmail: string;
let uniqueTelephone: string;

let originalExecuteMethod: any;

describe("Update Quote Status E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = UpdateQuoteStatusUseCase.prototype.execute;
  });

  beforeEach(async () => {
    uniqueName = `John Doe ${Date.now()}`;
    uniqueCompany = `Company ${Date.now()}`;
    uniqueEmail = `quote-${Date.now()}@example.com`;
    uniqueTelephone = `119${Math.random().toString().slice(2, 9)}`;

    await prisma.quote.deleteMany({});
  });

  afterEach(() => {
    UpdateQuoteStatusUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to update quote status", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "1-5",
    };

    const createQuote = await prisma.quote.create({
      data: quoteData,
    });

    const updateData = {
      status: "CONTACTED",
      notes: "Customer was contacted via phone",
    };

    const response = await request(serverInstance)
      .patch(`/quote/update-quote-status/${createQuote.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateData);

    const findQuoteById = await prisma.quote.findUnique({
      where: {
        id: createQuote.id,
      },
    });

    expect(response.statusCode).toEqual(200);
    expect(findQuoteById).toMatchObject({
      status: "CONTACTED",
      notes: "Customer was contacted via phone",
    });

    expect(response.body.message).toBe(
      "Status do orçamento atualizado com sucesso!",
    );
  });

  it("should be able to update quote status without notes", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "6-15",
    };

    const createQuote = await prisma.quote.create({
      data: quoteData,
    });

    const updateData = {
      status: "CLOSED",
    };

    const response = await request(serverInstance)
      .patch(`/quote/update-quote-status/${createQuote.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateData);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Status do orçamento atualizado com sucesso!",
    );
  });

  it("should throw QuoteNotFoundError if quote does not exist", async () => {
    const updateData = {
      status: "CONTACTED",
    };

    const response = await request(serverInstance)
      .patch(`/quote/update-quote-status/550e8400-e29b-41d4-a716-446655440000`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateData);

    expect(response.statusCode).toEqual(404);
    expect(response.body.message).toBe("Orçamento não encontrado!");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const updateData = {
      status: "CONTACTED",
    };

    UpdateQuoteStatusUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .patch(`/quote/update-quote-status/550e8400-e29b-41d4-a716-446655440001`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should reject update with invalid status", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "1-5",
    };

    const createQuote = await prisma.quote.create({
      data: quoteData,
    });

    const updateData = {
      status: "INVALID_STATUS",
    };

    const response = await request(serverInstance)
      .patch(`/quote/update-quote-status/${createQuote.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateData);

    expect(response.statusCode).toEqual(400);
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    const updateData = {
      status: "CONTACTED",
    };

    UpdateQuoteStatusUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .patch(`/quote/update-quote-status/550e8400-e29b-41d4-a716-446655440002`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateData);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});

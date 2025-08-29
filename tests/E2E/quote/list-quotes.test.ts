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

import { ListQuotesUseCase } from "@/modules/quote/usecases/list-quotes/list-quotes-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;

let uniqueName: string;
let uniqueCompany: string;

let uniqueEmail: string;
let uniqueTelephone: string;

let originalExecuteMethod: any;

describe("List Quotes E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = ListQuotesUseCase.prototype.execute;
  });

  beforeEach(async () => {
    uniqueName = `John Doe ${Date.now()}`;
    uniqueCompany = `Company ${Date.now()}`;
    uniqueEmail = `quote-${Date.now()}@example.com`;
    uniqueTelephone = `119${Math.random().toString().slice(2, 9)}`;

    // Clean quotes before each test
    await prisma.quote.deleteMany({});
  });

  afterEach(() => {
    ListQuotesUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should list quotes correctly", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "1-5",
      message: "I need a quote for my fleet",
    };

    await request(serverInstance).post("/quote/create-quote").send(quoteData);

    const response = await request(serverInstance)
      .get("/quote/list-quote")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    const splitResponse = response.text.split("\n");

    const parsedQuoteValues = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);
    expect(parsedQuoteValues.name).toBe(uniqueName);
    expect(parsedQuoteValues.company).toBe(uniqueCompany);

    const { meta } = parsedMetaData;

    expect(meta.total).toBe(1);
    expect(meta.page).toBe(1);
    expect(meta.pageSize).toBe(10);
  });

  it("should list quotes matching search query", async () => {
    const quoteData = {
      name: "Unique Customer Name",
      company: "Unique Company Name",
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "6-15",
    };

    await request(serverInstance).post("/quote/create-quote").send(quoteData);

    const response = await request(serverInstance)
      .get("/quote/list-quote")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, search: "Unique" });

    const splitResponse = response.text
      .split("\n")
      .filter((line) => line.trim() !== "");

    const parsedMetaData = JSON.parse(splitResponse[0]);
    const parsedQuote = JSON.parse(splitResponse[1]);

    expect(response.statusCode).toEqual(200);
    expect(parsedQuote.name).toBe("Unique Customer Name");

    expect(parsedMetaData.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("should list quotes filtered by status", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "1-5",
    };

    await request(serverInstance).post("/quote/create-quote").send(quoteData);

    const response = await request(serverInstance)
      .get("/quote/list-quote")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, status: "PENDING" });

    const splitResponse = response.text.split("\n");

    const parsedQuoteValues = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);
    expect(parsedQuoteValues.status).toBe("PENDING");

    const { meta } = parsedMetaData;
    expect(meta.total).toBeGreaterThanOrEqual(1);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    ListQuotesUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .get("/quote/list-quote")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ListQuotesUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .get("/quote/list-quote")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});

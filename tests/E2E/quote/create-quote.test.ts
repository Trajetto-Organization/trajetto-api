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

import { CreateQuoteUseCase } from "@/modules/quote/usecases/create-quote/create-quote-usecase";

let uniqueName: string;
let uniqueCompany: string;

let uniqueEmail: string;
let uniqueTelephone: string;

let originalExecuteMethod: any;

describe("Create Quote E2E", () => {
  beforeAll(async () => {
    await app.ready();
    originalExecuteMethod = CreateQuoteUseCase.prototype.execute;
  });

  beforeEach(() => {
    uniqueName = `John Doe ${Date.now()}`;
    uniqueCompany = `Company ${Date.now()}`;
    uniqueEmail = `quote-${Date.now()}@example.com`;
    uniqueTelephone = `119${Math.random().toString().slice(2, 9)}`;
  });

  afterEach(() => {
    CreateQuoteUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to create a quote", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "1-5",
      message: "I need a quote for my fleet management",
    };

    const response = await request(serverInstance)
      .post("/quote/create-quote")
      .send(quoteData);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Orçamento solicitado com sucesso! Em breve entraremos em contato.",
    );
  });

  it("should be able to create a quote without message", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "6-15",
    };

    const response = await request(serverInstance)
      .post("/quote/create-quote")
      .send(quoteData);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Orçamento solicitado com sucesso! Em breve entraremos em contato.",
    );
  });

  it("should reject quote with invalid email", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: "invalid-email",
      telephone: uniqueTelephone,
      fleet_size: "1-5",
    };

    const response = await request(serverInstance)
      .post("/quote/create-quote")
      .send(quoteData);

    expect(response.statusCode).toEqual(400);
  });

  it("should reject quote with invalid fleet size", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "invalid-size",
    };

    const response = await request(serverInstance)
      .post("/quote/create-quote")
      .send(quoteData);

    expect(response.statusCode).toEqual(400);
  });

  it("should reject quote with invalid telephone", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: "123", // too short
      fleet_size: "1-5",
    };

    const response = await request(serverInstance)
      .post("/quote/create-quote")
      .send(quoteData);

    expect(response.statusCode).toEqual(400);
  });

  it("should reject quote without required fields", async () => {
    const quoteData = {
      name: uniqueName,
      // missing required fields
    };

    const response = await request(serverInstance)
      .post("/quote/create-quote")
      .send(quoteData);

    expect(response.statusCode).toEqual(400);
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    const quoteData = {
      name: uniqueName,
      company: uniqueCompany,
      email: uniqueEmail,
      telephone: uniqueTelephone,
      fleet_size: "1-5",
    };

    CreateQuoteUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .post("/quote/create-quote")
      .send(quoteData);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});

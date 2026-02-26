import { v4 as uuidV4 } from "uuid";
import { IPartRepository } from "../IPart-repository";

import {
  Part,
  CreatePartProps,
  ListPartProps,
  ListPartByBusinessIdProps,
  UpdatePart,
  ListPartBusinessProps,
} from "../../dtos/part-dto";

interface ServiceOrderPartEntry {
  id: string;
  partId: string;
  serviceOrderId: string;
  quantity: number;
  unit_price: string;
}

class InMemoryPartRepository implements IPartRepository {
  public parts: Part[] = [];
  public serviceOrderParts: ServiceOrderPartEntry[] = [];

  addServiceOrderPart(
    entry: Omit<ServiceOrderPartEntry, "id">,
  ): ServiceOrderPartEntry {
    const serviceOrderPart: ServiceOrderPartEntry = {
      id: uuidV4(),
      ...entry,
    };
    this.serviceOrderParts.push(serviceOrderPart);
    return serviceOrderPart;
  }

  async createPart(partData: CreatePartProps): Promise<Part> {
    const newPart: Part = {
      id: uuidV4(),
      description: partData.description,
      unit_price: partData.unit_price.toString(),
      businessId: partData.businessId,
      supplierId: partData.supplierId || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.parts.push(newPart);
    return newPart;
  }

  async listParts({
    page,
    pageSize,
    businessId,
    search,
  }: ListPartByBusinessIdProps): Promise<ListPartProps> {
    let filteredParts = this.parts.filter(
      (part) => part.businessId === businessId,
    );

    if (search) {
      const searchTerm = search.toLowerCase();
      filteredParts = filteredParts.filter((part) =>
        part.description.toLowerCase().includes(searchTerm),
      );
    }

    const skip = (page - 1) * pageSize;

    const data = filteredParts.slice(skip, skip + pageSize);
    const total = filteredParts.length;

    return { data, total };
  }

  async listPartBusiness({
    page,
    pageSize,
    businessId,
  }: ListPartBusinessProps): Promise<ListPartProps> {
    const filteredParts = this.parts.filter(
      (part) => part.businessId === businessId,
    );

    const skip = (page - 1) * pageSize;
    const data = filteredParts.slice(skip, skip + pageSize);

    const total = filteredParts.length;
    return { data, total };
  }

  async updatePart({ partData, partId }: UpdatePart): Promise<Part> {
    const index = this.parts.findIndex((part) => part.id === partId);

    if (index === -1) {
      throw new Error("Part not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(partData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    // Convert unit_price to string if it exists
    if (filteredData.unit_price) {
      filteredData.unit_price = filteredData.unit_price.toString();
    }

    const updatedPart: Part = {
      ...this.parts[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.parts[index] = updatedPart;
    return updatedPart;
  }

  async deletePart(partId: string): Promise<Part> {
    const index = this.parts.findIndex((part) => part.id === partId);

    if (index === -1) {
      throw new Error("Part not found");
    }

    const deletedPart = this.parts.splice(index, 1)[0];
    return deletedPart;
  }

  async findPartById(partId: string): Promise<Part | null> {
    const part = this.parts.find((part) => part.id === partId);

    return part || null;
  }

  async findPartByDescription(
    description: string,
    businessId: string,
  ): Promise<Part | null> {
    const part = this.parts.find(
      (part) =>
        part.description === description && part.businessId === businessId,
    );

    return part || null;
  }

  async findServiceOrderPartsByPartId(partId: string): Promise<Part[]> {
    const associatedParts = this.serviceOrderParts.filter(
      (sop) => sop.partId === partId,
    );

    return associatedParts as any[];
  }
}

export { InMemoryPartRepository };

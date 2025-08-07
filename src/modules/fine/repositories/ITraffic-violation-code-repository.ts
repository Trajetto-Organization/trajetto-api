import {
  TrafficViolationCode,
  ListTrafficViolationCodeProps,
  ListTrafficViolationCodeByBusinessIdProps,
  TrafficViolationCodeStatistics,
} from "../dtos/traffic-violation-code-dto";

interface ITrafficViolationCodeRepository {
  listTrafficViolationCodes: (
    listProps: ListTrafficViolationCodeByBusinessIdProps,
  ) => Promise<ListTrafficViolationCodeProps>;
  findTrafficViolationCodeById: (
    id: string,
  ) => Promise<TrafficViolationCode | null>;
  findTrafficViolationCodeByCode: (
    code: string,
    subCode?: number,
  ) => Promise<TrafficViolationCode | null>;
  getTrafficViolationCodeStatistics: () => Promise<TrafficViolationCodeStatistics>;
  getMostUsedViolationCodes: (
    businessId: string,
    limit?: number,
  ) => Promise<TrafficViolationCode[]>;
  searchTrafficViolationCodes: (
    search: string,
    limit?: number,
  ) => Promise<TrafficViolationCode[]>;
}

export { ITrafficViolationCodeRepository };

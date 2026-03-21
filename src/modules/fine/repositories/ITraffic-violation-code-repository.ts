import {
  ListTrafficViolationCodeProps,
  ListTrafficViolationCodeByBusinessIdProps,
  TrafficViolationCode,
  SearchTrafficViolationCodeWithCursorProps,
  CursorPaginatedTrafficViolationCode,
} from "../dtos/traffic-violation-code-dto";

interface ITrafficViolationCodeRepository {
  findTrafficViolationCodeById: (
    id: string,
  ) => Promise<TrafficViolationCode | null>;
  listTrafficViolationCodes: (
    listProps: ListTrafficViolationCodeByBusinessIdProps,
  ) => Promise<ListTrafficViolationCodeProps>;
  searchTrafficViolationCodeWithCursor: (
    props: SearchTrafficViolationCodeWithCursorProps,
  ) => Promise<CursorPaginatedTrafficViolationCode>;
}

export { ITrafficViolationCodeRepository };

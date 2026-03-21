interface TrafficViolationCode {
  id: string;
  code: string;
  sub_code: number;
  description: string;
  legal_basis: string;
  violator_type: string;
  gravity: "LIGHT" | "MEDIUM" | "SERIOUS" | "VERY_SERIOUS" | "NO_POINTS";
  gravity_raw: string;
  points: number;
  competent_agency: string;
  created_at: Date | string;
  updated_at: Date | string;

  // Extended fields
  gravityLabel?: string;
  fullCode?: string; // Ex: "5010-0"
}

interface ListTrafficViolationCodeProps {
  data: TrafficViolationCode[];
  total: number;
}

interface ListTrafficViolationCodeByBusinessIdProps {
  page: number;
  pageSize: number;
  search?: string;
  gravity?: "LIGHT" | "MEDIUM" | "SERIOUS" | "VERY_SERIOUS" | "NO_POINTS";
  violatorType?: string;
}

interface SearchTrafficViolationCodeWithCursorProps {
  limit: number;
  cursor?: string;
}

interface CursorPaginatedTrafficViolationCode {
  data: TrafficViolationCode[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  TrafficViolationCode,
  ListTrafficViolationCodeProps,
  ListTrafficViolationCodeByBusinessIdProps,
  SearchTrafficViolationCodeWithCursorProps,
  CursorPaginatedTrafficViolationCode,
};

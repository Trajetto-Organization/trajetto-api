/**
 * The parts of exceljs the row-at-a-time reader drives one by one
 * (src/shared/delivery/xlsx-row-reader.ts): the very classes the package's
 * own `xlsx.load` uses, which it ships without typings. Only what that reader
 * touches. exceljs is pinned in package.json, and the reader's differential
 * test (tests/unitaires/delivery/xlsx-row-reader.test.ts) compares its rows
 * with the whole load's, so a bump that changes these internals fails there.
 */

declare module "exceljs/lib/utils/parse-sax" {
  interface SaxEvent {
    eventType: "opentag" | "text" | "closetag";
    value: unknown;
  }

  function parseSax(iterable: AsyncIterable<string>): AsyncIterable<SaxEvent[]>;

  export = parseSax;
}

declare module "exceljs/lib/xlsx/xform/book/workbook-xform" {
  interface WorkbookSheet {
    id: number;
    name: string;
    rId: string;
  }

  interface WorkbookModel {
    sheets?: WorkbookSheet[];
    properties?: { date1904?: boolean };
  }

  class WorkbookXform {
    parse(events: AsyncIterable<unknown>): Promise<WorkbookModel | undefined>;
  }

  export = WorkbookXform;
}

declare module "exceljs/lib/xlsx/xform/core/relationships-xform" {
  interface Relationship {
    Id: string;
    Target: string;
  }

  class RelationshipsXform {
    parse(events: AsyncIterable<unknown>): Promise<Relationship[] | undefined>;
  }

  export = RelationshipsXform;
}

declare module "exceljs/lib/xlsx/xform/style/styles-xform" {
  class StylesXform {
    parse(events: AsyncIterable<unknown>): Promise<unknown>;
  }

  export = StylesXform;
}

declare module "exceljs/lib/xlsx/xform/strings/shared-strings-xform" {
  class SharedStringsXform {
    parse(events: AsyncIterable<unknown>): Promise<unknown>;
  }

  export = SharedStringsXform;
}

declare module "exceljs/lib/xlsx/xform/sheet/worksheet-xform" {
  /** A `<row>` as RowXform parses it, before and after its reconcile. */
  interface RowModel {
    number: number;
    cells: unknown[];
  }

  interface RowXform {
    reconcile(model: RowModel, options: object): void;
  }

  /** The `<sheetData>` list: the rows parsed so far, in document order. */
  interface SheetDataXform {
    model: RowModel[] | null | undefined;
    childXform: RowXform;
    parseClose(name: string): boolean;
  }

  interface ListXform {
    model: unknown[] | null | undefined;
  }

  class WorksheetXform {
    map: {
      sheetData: SheetDataXform;
      mergeCells: ListXform;
      hyperlinks: ListXform;
    };

    parse(events: AsyncIterable<unknown>): Promise<unknown>;
  }

  export = WorksheetXform;
}

declare module "exceljs/lib/doc/column" {
  class Column {
    constructor(worksheet: object, number: number);
  }

  export = Column;
}

declare module "exceljs/lib/doc/row" {
  class Row {
    constructor(
      worksheet: { getColumn(number: number): unknown },
      number: number,
    );

    model: unknown;

    readonly hasValues: boolean;

    readonly values: unknown[];
  }

  export = Row;
}

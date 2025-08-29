import * as XLSX from "xlsx";
import { AppError } from "@/shared/errors/AppError";

interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
  formatter?: (value: any) => string;
}

interface ExcelExportConfig {
  data: any[];
  columns: ExcelColumn[];
  sheetName: string;
  filename: string;
}

interface ExcelExportResult {
  buffer: Buffer;
  filename: string;
  totalRecords: number;
}

class ExcelExportService {
  static execute(config: ExcelExportConfig): ExcelExportResult {
    try {
      const { data, columns, sheetName, filename } = config;

      if (!data || data.length === 0) {
        throw new AppError(
          "Nenhum dado encontrado para exportar. Certifique-se de que existem dados antes de gerar o relatório.",
          400,
        );
      }

      // Prepare data for Excel with custom formatting
      const excelData = data.map((item) => {
        const formattedItem: Record<string, any> = {};

        columns.forEach((column) => {
          const value = this.getNestedValue(item, column.key);
          formattedItem[column.header] = column.formatter
            ? column.formatter(value)
            : this.formatDefaultValue(value);
        });

        return formattedItem;
      });

      // Create workbook
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);

      // Set column widths
      const columnWidths = columns.map((column) => ({
        wch: column.width || 15,
      }));

      worksheet["!cols"] = columnWidths;

      // Add worksheet to workbook
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

      // Generate Excel file buffer
      const excelBuffer = XLSX.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
      });

      const finalFilename = filename.endsWith(".xlsx")
        ? filename
        : `${filename}.xlsx`;

      return {
        buffer: excelBuffer,
        filename: finalFilename,
        totalRecords: data.length,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar gerar o relatório Excel! Por favor, tente novamente.",
        500,
      );
    }
  }

  private static getNestedValue(obj: any, path: string): any {
    return path.split(".").reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : null;
    }, obj);
  }

  private static formatDefaultValue(value: any): string {
    if (value === null || value === undefined) {
      return "N/A";
    }

    if (value instanceof Date) {
      return value.toLocaleDateString("pt-BR");
    }

    if (typeof value === "boolean") {
      return value ? "Sim" : "Não";
    }

    return String(value);
  }

  static formatters = {
    currency: (value: any): string => {
      if (value === null || value === undefined) return "N/A";
      return new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(Number(value));
    },

    date: (value: any): string => {
      if (!value) return "N/A";
      return new Date(value).toLocaleDateString("pt-BR");
    },

    datetime: (value: any): string => {
      if (!value) return "N/A";
      return new Date(value).toLocaleString("pt-BR");
    },

    boolean: (value: any): string => {
      if (value === null || value === undefined) return "N/A";
      return value ? "Sim" : "Não";
    },

    cpf: (value: any): string => {
      if (!value) return "N/A";
      const cpf = String(value).replace(/\D/g, "");
      return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    },

    cnpj: (value: any): string => {
      if (!value) return "N/A";
      const cnpj = String(value).replace(/\D/g, "");
      return cnpj.replace(
        /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
        "$1.$2.$3/$4-$5",
      );
    },

    phone: (value: any): string => {
      if (!value) return "N/A";
      const phone = String(value).replace(/\D/g, "");
      if (phone.length === 11) {
        return phone.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
      } else if (phone.length === 10) {
        return phone.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
      }
      return value;
    },
  };
}

export { ExcelExportService, type ExcelColumn, type ExcelExportConfig };

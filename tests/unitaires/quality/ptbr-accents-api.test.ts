import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every sentence the API sends a person is pt-BR WITH accents ("Sessão
 * inválida.", not "Sessao invalida."). The auth middleware, the refresh flow
 * and the socket layer answered without them, and the web and the app show
 * the API's message as it comes.
 *
 * Scans string literals in src/. Left out on purpose: identifiers the
 * clients match (file names, enum tokens like `nao_sei`), spreadsheet header
 * aliases (matched after accent folding) and the X.509 subject format.
 */
const SRC = path.join(process.cwd(), "src");

const NOT_PROSE = new Set([
  "shared/ai/ai-prompts.ts",
  "shared/delivery/spreadsheet-template.ts",
  "shared/services/proof-signing/signing-certificate.ts",
]);

const UNACCENTED =
  /(?<!\p{L})(nao|voce|usuarios?|veiculos?|codigos?|invalid[oa]s?|obrigatori[oa]s?|sessao|permissao|permissoes|informacoes|operacao|configuracao|exclusao|criacao|atualizacao|notificac(?:ao|oes)|tambem|horario|historico|endereco|manutencao|disponivel|indisponivel|periodo|possivel|minimo|maximo|proxim[oa]|ultim[oa]|conteudo|requisicao|autenticacao|autorizacao|situacao|localizacao|opcao|acao|padrao|conexao|conexoes|versao|cabecalho|servico)(?!\p{L})/iu;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.includes("generated"))
      out.push(full);
  }

  return out;
}

function unaccentedLiterals(file: string, text: string): string[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (/^\s*(\/\/|\*)/.test(line)) return [];

    return (
      [...line.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)]
        .map(([literal]) => literal)
        // A slug or a file name is an identifier, not a sentence.
        .filter((literal) => /\s/.test(literal) && UNACCENTED.test(literal))
        .map((literal) => `${file}:${index + 1} ${literal.slice(0, 90)}`)
    );
  });
}

describe("pt-BR sentences of the API", () => {
  it("carry their accents", () => {
    const offenders = sources(SRC).flatMap((full) => {
      const file = path.relative(SRC, full).split(path.sep).join("/");

      return NOT_PROSE.has(file)
        ? []
        : unaccentedLiterals(file, readFileSync(full, "utf8"));
    });

    expect(offenders).toEqual([]);
  });

  it("flags a sentence without accents and leaves identifiers alone (self-test)", () => {
    expect(
      unaccentedLiterals(
        "x.ts",
        'throw new AppError("Sessao invalida.", 401);',
      ),
    ).toHaveLength(1);
    expect(
      unaccentedLiterals(
        "x.ts",
        'throw new AppError("Sessão inválida.", 401);',
      ),
    ).toEqual([]);
    expect(
      unaccentedLiterals("x.ts", 'const name = "relatorio-veiculos";'),
    ).toEqual([]);
  });
});

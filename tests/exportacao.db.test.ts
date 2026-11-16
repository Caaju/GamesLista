import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Queryable, type SearchFilters, webExportRecords } from "../db.js";

const RID = "req-export";

let output: string[] = [];

beforeEach(() => {
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logs(): Record<string, string>[] {
  return output
    .join("")
    .split("\n")
    .filter((line) => line.startsWith('{"timestamp"'))
    .map((line) => JSON.parse(line));
}

function fakeDb(rows: unknown[] = []): Queryable & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(async () => ({ rows })) };
}

function failingDb(): Queryable {
  return {
    query: vi.fn(async () => {
      throw new Error("conexão recusada");
    }),
  };
}

describe("webExportRecords", () => {
  it("exporta todos os jogos ativos sem filtros ou paginação", async () => {
    const rows = [{ id: 1, title: "Hades", active: 1 }];
    const db = fakeDb(rows);

    expect(await webExportRecords(db, {}, "web", RID)).toEqual(rows);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SELECT id, title, platform, genre, release_year, rating, notes, active");
    expect(sql).toContain("WHERE active = 1");
    expect(sql).toContain("ORDER BY id ASC");
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(values).toEqual([]);
  });

  it("reutiliza todos os filtros, enviando os valores apenas como parâmetros", async () => {
    const filters: SearchFilters = {
      q: "100%_",
      platform: "PC",
      genre: "RPG",
      yearMin: 1990,
      yearMax: 2025,
      ratingMin: 8.5,
    };
    const db = fakeDb();

    await webExportRecords(db, filters, "web", RID);

    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("LOWER(title) LIKE");
    expect(sql).toContain("LOWER(platform) = LOWER($2)");
    expect(sql).toContain("LOWER(genre) = LOWER($3)");
    expect(sql).toContain("release_year >= $4");
    expect(sql).toContain("release_year <= $5");
    expect(sql).toContain("rating >= $6");
    expect(sql).not.toContain("100%_");
    expect(values).toEqual(["100\\%\\_", "PC", "RPG", 1990, 2025, 8.5]);
  });

  it("registra sucesso e request_id na camada db", async () => {
    await webExportRecords(fakeDb(), {}, "web", RID);

    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        client: "web",
        operation: "export_records",
        status: "success",
        request_id: RID,
      }),
    ]);
  });

  it("registra erro e repassa a falha do banco", async () => {
    await expect(webExportRecords(failingDb(), {}, "web", RID)).rejects.toThrow("conexão recusada");

    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        operation: "export_records",
        status: "error",
        level: "ERROR",
      }),
    ]);
  });
});

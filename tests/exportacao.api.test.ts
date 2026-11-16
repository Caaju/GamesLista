import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import type { Queryable } from "../db.js";

let output: string[] = [];
let servers: Server[] = [];

beforeEach(() => {
  output = [];
  servers = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

function logs(): Record<string, string>[] {
  return output
    .join("")
    .split("\n")
    .filter((line) => line.startsWith('{"timestamp"'))
    .map((line) => JSON.parse(line));
}

type FakeDb = Queryable & { query: ReturnType<typeof vi.fn> };

function gamesDb(rows: unknown[]): FakeDb {
  return { query: vi.fn(async () => ({ rows })) };
}

function failingDb(): Queryable {
  return {
    query: vi.fn(async () => {
      throw new Error("banco fora do ar");
    }),
  };
}

async function listen(db: Queryable): Promise<{ base: string; auth: { Authorization: string } }> {
  const tokens = new TokenStore();
  const server = createApp(db, tokens).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, auth: { Authorization: `Bearer ${tokens.issue("web")}` } };
}

describe("GET /api/web/records/export", () => {
  it("sem filtros inclui todos os resultados, além da página padrão, e registra logs correlacionados", async () => {
    const records = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      title: `Jogo ${index + 1}`,
      platform: "PC",
      genre: "RPG",
      release_year: 2020,
      rating: 9,
      notes: null,
      active: 1,
    }));
    const db = gamesDb(records);
    const { base, auth } = await listen(db);

    const response = await fetch(`${base}/api/web/records/export`, { headers: auth });
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="games.csv"');
    expect(csv.split("\r\n")).toHaveLength(8);
    expect(csv.split("\r\n")[0]).toBe('"id","title","platform","genre","release_year","rating","notes","active"');
    expect(csv).toContain('"7","Jogo 7","PC","RPG","2020","9","","1"');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);

    const requestId = response.headers.get("x-request-id");
    expect(logs().filter((entry) => entry.request_id === requestId).map((entry) => `${entry.layer}:${entry.operation}`))
      .toEqual(["db:export_records", "api:export_records"]);
  });

  it("aplica filtros e escapa vírgulas, aspas e quebras de linha", async () => {
    const db = gamesDb([
      {
        id: 1,
        title: 'Jogo, "Especial"\nEdição',
        platform: "PC",
        genre: "RPG",
        release_year: 2020,
        rating: 9.5,
        notes: 'nota, "citada"\r\ncontinuação',
        active: 1,
      },
    ]);
    const { base, auth } = await listen(db);
    const query = new URLSearchParams({
      q: "especial",
      platform: "PC",
      genre: "RPG",
      year_min: "2018",
      year_max: "2024",
      rating_min: "8.5",
    });

    const response = await fetch(`${base}/api/web/records/export?${query}`, { headers: auth });
    const csv = await response.text();
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];

    expect(response.status).toBe(200);
    expect(values).toEqual(["especial", "PC", "RPG", 2018, 2024, 8.5]);
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(csv).toContain('"1","Jogo, ""Especial""\nEdição","PC","RPG","2020","9.5","nota, ""citada""\r\ncontinuação","1"');
  });

  it("responde 400 para filtros inválidos sem consultar o banco", async () => {
    const db = gamesDb([]);
    const { base, auth } = await listen(db);

    const response = await fetch(`${base}/api/web/records/export?rating_min=11`, { headers: auth });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Parâmetros inválidos" });
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().find((entry) => entry.operation === "export_records")).toMatchObject({
      layer: "api",
      level: "WARN",
    });
  });

  it("responde 401 sem token válido e não consulta o banco", async () => {
    const db = gamesDb([]);
    const { base } = await listen(db);

    expect((await fetch(`${base}/api/web/records/export`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/web/records/export`, {
          headers: { Authorization: "Bearer inválido" },
        })
      ).status,
    ).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("responde 500 e registra erro da API e do banco quando a consulta falha", async () => {
    const { base, auth } = await listen(failingDb());

    const response = await fetch(`${base}/api/web/records/export`, { headers: auth });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((entry) => entry.level === "ERROR").map((entry) => `${entry.layer}:${entry.operation}`))
      .toEqual(["db:export_records", "api:export_records"]);
  });
});

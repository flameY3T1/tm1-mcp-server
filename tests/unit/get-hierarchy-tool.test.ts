import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerGetHierarchy } from "../../src/tools/metadata/get-hierarchy.js";
import { HierarchyService } from "../../src/tm1-client/services/hierarchy-service.js";
import type { TM1Client } from "../../src/tm1-client.js";

// Synthetic pool of 5 leaf elements. The mock honours OData $top/$skip/$count
// so the real HierarchyService applies the tool's window exactly like the
// server would (live-verified: TM1 answers a nested
// `$expand=Elements($orderby=Name;$top;$skip;$count=true)` with the window plus
// an `Elements@odata.count` covering the whole filtered set).
const POOL = ["E1", "E2", "E3", "E4", "E5"].map((Name) => ({
  Name,
  Type: "Numeric",
  Level: 0,
  Parents: [],
}));

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function makeFakeServer() {
  let captured: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (
      _name: string,
      _desc: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) => {
      parser = z.object(schema);
      captured = handler;
    },
  };
  return {
    server: server as unknown as Parameters<typeof registerGetHierarchy>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      return (args) => h(p.parse(args));
    },
  };
}

function makeTM1Client(paths: string[]): TM1Client {
  const request = async (_method: string, path: string) => {
    paths.push(path);
    const top = path.match(/\$top=(\d+)/);
    const skip = path.match(/\$skip=(\d+)/);
    const from = skip ? Number(skip[1]) : 0;
    const n = top ? Number(top[1]) : POOL.length;
    return {
      Name: "H",
      Elements: POOL.slice(from, from + n),
      ...(path.includes("$count=true")
        ? { "Elements@odata.count": POOL.length }
        : {}),
    };
  };
  const hierarchies = new HierarchyService({
    request,
  } as unknown as ConstructorParameters<typeof HierarchyService>[0]);
  return { hierarchies } as unknown as TM1Client;
}

describe("tm1_get_hierarchy tool", () => {
  it("applies a default cap of 1000 when topN is omitted", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetHierarchy(server, makeTM1Client(paths));

    const res = await getHandler()({ dimensionName: "D", hierarchyName: "H" });
    const out = JSON.parse(res.content[0].text);

    expect(paths[0]).toContain("$top=1000");
    expect(out.elements).toHaveLength(5);
    expect(out.truncated).toBe(false);
  });

  it("sets truncated=true when the cap clips the element set", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetHierarchy(server, makeTM1Client(paths));

    const res = await getHandler()({
      dimensionName: "D",
      hierarchyName: "H",
      topN: 3,
    });
    const out = JSON.parse(res.content[0].text);

    expect(paths[0]).toContain("$top=3");
    expect(out.elements).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("a higher topN returns more elements and clears the truncated flag", async () => {
    const { server, getHandler } = makeFakeServer();
    const paths: string[] = [];
    registerGetHierarchy(server, makeTM1Client(paths));

    const low = JSON.parse(
      (await getHandler()({ dimensionName: "D", hierarchyName: "H", topN: 3 }))
        .content[0].text,
    );
    const high = JSON.parse(
      (await getHandler()({ dimensionName: "D", hierarchyName: "H", topN: 10 }))
        .content[0].text,
    );

    expect(high.elements.length).toBeGreaterThan(low.elements.length);
    expect(high.elements).toHaveLength(5);
    expect(high.truncated).toBe(false);
  });

  it("pushes the window down as $orderby=Name + $top + $skip + $count=true", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetHierarchy(server, makeTM1Client(paths));

    await getHandler()({
      dimensionName: "D",
      hierarchyName: "H",
      topN: 2,
      offset: 2,
    });

    // $orderby is not decoration: $skip without it walks TM1's internal index
    // order, which shifts on every element create/delete.
    expect(paths[0]).toContain("$orderby=Name");
    expect(paths[0]).toContain("$top=2");
    expect(paths[0]).toContain("$skip=2");
    expect(paths[0]).toContain("$count=true");
  });

  it("walks the whole set with offset without duplicating or dropping elements", async () => {
    const { server, getHandler } = makeFakeServer();
    registerGetHierarchy(server, makeTM1Client([]));
    const handler = getHandler();

    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = JSON.parse(
        (
          await handler({
            dimensionName: "D",
            hierarchyName: "H",
            topN: 2,
            offset,
          })
        ).content[0].text,
      );
      expect(page.offset).toBe(offset);
      expect(page.total).toBe(5);
      seen.push(...page.elements.map((e: { name: string }) => e.name));
      if (!page.has_more) break;
      offset += page.elements.length;
    }

    expect(seen).toEqual(["E1", "E2", "E3", "E4", "E5"]);
  });

  it("reports has_more=false on a last page that is exactly topN long", async () => {
    const { server, getHandler } = makeFakeServer();
    registerGetHierarchy(server, makeTM1Client([]));

    // 5 elements, offset 3, topN 2 → the page is full yet nothing remains.
    // Deriving has_more from `count === topN` would wrongly promise a page 4.
    const out = JSON.parse(
      (
        await getHandler()({
          dimensionName: "D",
          hierarchyName: "H",
          topN: 2,
          offset: 3,
        })
      ).content[0].text,
    );

    expect(out.elements).toHaveLength(2);
    expect(out.total).toBe(5);
    expect(out.has_more).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it("keeps offset/total exact when a client-side filter forces the fallback path", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetHierarchy(server, makeTM1Client(paths));

    // nameRegex cannot be expressed in OData, so the service must fetch the
    // whole set and window it here — pushing $top down would return the wrong
    // rows and an @odata.count covering elements the filter removed.
    const out = JSON.parse(
      (
        await getHandler()({
          dimensionName: "D",
          hierarchyName: "H",
          nameRegex: "E[2-4]",
          topN: 2,
          offset: 1,
        })
      ).content[0].text,
    );

    expect(paths[0]).not.toContain("$top=");
    expect(paths[0]).not.toContain("$skip=");
    expect(out.elements.map((e: { name: string }) => e.name)).toEqual([
      "E3",
      "E4",
    ]);
    expect(out.total).toBe(3);
    expect(out.has_more).toBe(false);
  });
});

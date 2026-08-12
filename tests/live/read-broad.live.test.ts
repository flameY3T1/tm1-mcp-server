// Broad read-only sweep over a real model.
//
// The rest of the live suite works almost entirely on objects it creates
// itself under the sandbox prefix. Those objects are deliberately minimal — a
// two-element dimension, an empty cube, a process with no data source — so
// whole branches of the response shapes never appear: cells are always null,
// a view's MDX is never populated, a process never carries an ODBC data
// source, an element never has children.
//
// That thinness is invisible in normal test runs and load-bearing for the wire
// contracts, which are recorded from live traffic: a contract that only ever
// saw `Value: null` will later reject a perfectly valid fake that uses
// numbers. This file walks the model that is actually on the server —
// whatever it is — and reads it, so the recording sees populated shapes.
//
// Strictly read-only: safe to point at any server, including production.
// Every call is discovery-driven; nothing is created, changed, or deleted.
import { describe, it, expect, beforeAll } from "vitest";
import { getHarness, LIVE_ENABLED, type LiveHarness } from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: broad read sweep", () => {
  let h: LiveHarness;
  let cube: string | undefined;
  let dimension: string | undefined;
  let process: string | undefined;

  beforeAll(async () => {
    h = await getHarness();
    const cubes = await h.ok("tm1_list_cubes", { limit: 5 });
    cube = (cubes.json as { items?: Array<{ name: string }> }).items?.[0]?.name;
    const dims = await h.ok("tm1_list_dimensions", { limit: 5 });
    dimension = (dims.json as { items?: Array<{ name: string }> }).items?.[0]
      ?.name;
    const procs = await h.ok("tm1_list_processes", { limit: 5 });
    process = (procs.json as { items?: Array<{ name: string }> }).items?.[0]
      ?.name;
  });

  it("finds something to read", () => {
    // Not an assertion about any particular model — only that the server has
    // enough content for the rest of this file to mean anything.
    expect([cube, dimension, process].some(Boolean)).toBe(true);
  });

  it("reads a cube's views, definitions and rules", async () => {
    if (!cube) return;
    const views = await h.ok("tm1_list_views", { cubeName: cube, limit: 5 });
    const first = (views.json as { items?: Array<{ name: string }> }).items?.[0]
      ?.name;
    if (first) {
      await h.ok("tm1_get_view_definition", {
        cubeName: cube,
        viewName: first,
      });
      // Real cells: the sandbox cube is empty, so this is the only place a
      // populated Value/FormattedValue shape is ever observed.
      await h.call("tm1_get_view", {
        cubeName: cube,
        viewName: first,
        limit: 20,
      });
    }
    await h.call("tm1_get_cube_rules", { cubeName: cube });
    await h.call("tm1_get_cube_stats", { cubeName: cube });
  });

  it("reads a dimension's hierarchy, elements, subsets and attributes", async () => {
    if (!dimension) return;
    // TM1's default hierarchy carries the dimension's own name.
    const hierarchyName = dimension;
    await h.call("tm1_list_subsets", {
      dimensionName: dimension,
      hierarchyName,
      limit: 5,
    });
    await h.call("tm1_list_element_attributes", {
      dimensionName: dimension,
      hierarchyName,
    });
    const hier = await h.ok("tm1_get_hierarchy", {
      dimensionName: dimension,
      hierarchyName,
      limit: 50,
    });
    const el = (hier.json as { elements?: Array<{ name: string }> })
      .elements?.[0]?.name;
    if (el) {
      // Consolidated elements are where Children/Parents actually appear.
      await h.call("tm1_get_descendants", {
        dimensionName: dimension,
        hierarchyName,
        elementName: el,
      });
      await h.call("tm1_get_ancestors", {
        dimensionName: dimension,
        hierarchyName,
        elementName: el,
      });
      await h.call("tm1_get_element_attribute_values", {
        dimensionName: dimension,
        hierarchyName,
        elementName: el,
      });
    }
  });

  it("reads a process with its real data source, parameters and variables", async () => {
    if (!process) return;
    // A real process is the only source of a populated DataSource shape —
    // ODBC/ASCII fields that a sandbox process never has.
    await h.ok("tm1_get_process", { processName: process });
    await h.call("tm1_get_process_datasource", { processName: process });
    await h.call("tm1_get_process_parameters", { processName: process });
    await h.call("tm1_get_process_variables", { processName: process });
    await h.call("tm1_get_process_code", { processName: process });
  });

  it("reads server-level collections", async () => {
    await h.call("tm1_get_server_info");
    await h.call("tm1_list_chores", { limit: 5 });
    await h.call("tm1_list_clients", { limit: 5 });
    await h.call("tm1_list_groups", { limit: 5 });
    await h.call("tm1_list_sessions", { limit: 5 });
    await h.call("tm1_list_error_logs", { limit: 5 });
    await h.call("tm1_list_files", { limit: 5 });
  });
});

import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { Column } from "../types.js";
import { ResourceTable } from "./resource-table.js";

type Row = {
  id: string;
  title: string;
  status: string;
};

const columns: Column<Row>[] = [
  { key: "status", label: "Status", width: 12, render: (row) => row.status },
  { key: "title", label: "Title", width: 24, render: (row) => row.title },
];

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

test("resource table shows loading state", async () => {
  setup = await testRender(
    <ResourceTable
      columns={columns}
      data={[]}
      cursor={0}
      keyFn={(row) => row.id}
      loading
      emptyMessage="No rows"
    />,
    { width: 72, height: 20 },
  );

  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Loading ORC data");
});

test("resource table shows filtered empty state", async () => {
  setup = await testRender(
    <ResourceTable
      columns={columns}
      data={[]}
      cursor={0}
      keyFn={(row) => row.id}
      loading={false}
      hasActiveFilter
      emptyMessage="No rows"
      filteredEmptyMessage="No rows match"
    />,
    { width: 72, height: 20 },
  );

  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("No rows match");
  expect(frame).toMatchSnapshot();
});

test("resource table keeps the selected row visible in a short viewport", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `row-${index + 1}`,
    title: `Row ${index + 1}`,
    status: index === 9 ? "selected" : "idle",
  }));

  setup = await testRender(
    <ResourceTable
      columns={columns}
      data={rows}
      cursor={9}
      keyFn={(row) => row.id}
      loading={false}
      emptyMessage="No rows"
    />,
    { width: 72, height: 12 },
  );

  await setup.renderOnce();
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Row 10");
  expect(frame).toContain("10 / 12");
});

import { Cell, Pie, PieChart } from "recharts";

export default function ContextRing({ percent, color }: { percent: number; color: string }) {
  const used = Math.min(100, Math.max(0, percent));
  return (
    <span data-testid="chat-context-ring" aria-hidden="true" className="inline-flex">
      <PieChart width={16} height={16}>
        <Pie
          data={[{ value: used }, { value: 100 - used }]}
          dataKey="value"
          innerRadius={5}
          outerRadius={8}
          startAngle={90}
          endAngle={-270}
          stroke="none"
          isAnimationActive={false}
        >
          <Cell fill={color} />
          <Cell fill="var(--color-outline-variant)" />
        </Pie>
      </PieChart>
    </span>
  );
}

// Light-DOM elements reuse the kit's styles and tab controller inside each sandbox.
// Attribute values become text nodes; they never become executable markup.
export const ORC_KIT_ELEMENTS_JS = `const registerOrcElements = (selectTab) => {
  const define = (name, element) => {
    if (!customElements.get(name)) customElements.define(name, element);
  };
  for (const name of ["page", "grid", "row", "card"]) {
    define("orc-" + name, class extends HTMLElement {
      connectedCallback() { this.classList.add("orc-" + name); }
    });
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svgNode = (name, attributes) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  // Only a JSON array of numbers or {label,value} objects becomes a chart; anything
  // else renders the empty state instead of guessing.
  const chartData = (raw) => {
    if (!raw) return [];
    let value;
    try { value = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(value)) return [];
    const points = [];
    for (const [index, item] of value.entries()) {
      if (typeof item === "number" && Number.isFinite(item)) {
        points.push({ label: String(index + 1), value: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const number = typeof item.value === "number" ? item.value : Number(item.value);
      if (!Number.isFinite(number)) continue;
      points.push({ label: String(item.label ?? index + 1), value: number });
    }
    return points;
  };
  const chartNumber = (value) => {
    const abs = Math.abs(value);
    const digits = abs >= 10 ? 0 : abs >= 1 ? 1 : 2;
    return String(Number(value.toFixed(digits)));
  };
  const niceStep = (raw) => {
    if (!(raw > 0)) return 1;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const fraction = raw / power;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  };
  define("orc-chart", class extends HTMLElement {
    static observedAttributes = ["kind", "data", "label", "unit", "height", "min", "max"];
    constructor() {
      super();
      this.width = 0;
      this.resize = new ResizeObserver(() => {
        if (this.width !== Math.floor(this.clientWidth)) this.draw();
      });
    }
    connectedCallback() {
      this.classList.add("orc-chart");
      this.resize.observe(this);
      this.draw();
    }
    disconnectedCallback() { this.resize.disconnect(); }
    attributeChangedCallback() { if (this.isConnected) this.draw(); }
    draw() {
      // Pads written before kit v3 use <orc-chart> as a plain container with
      // their own SVG; only a data-driven element owns its children.
      if (!this.hasAttribute("data")) return;
      const width = Math.max(120, Math.floor(this.clientWidth || 320));
      this.width = width;
      const kind = ["bar", "line", "area", "sparkline"].includes(this.getAttribute("kind"))
        ? this.getAttribute("kind") : "line";
      const spark = kind === "sparkline";
      const height = Math.max(24, Number(this.getAttribute("height")) || (spark ? 40 : 160));
      const data = chartData(this.getAttribute("data"));
      const unit = this.getAttribute("unit") ?? "";
      const captionText = this.getAttribute("label");
      this.replaceChildren();
      if (captionText) {
        const caption = document.createElement("span");
        caption.className = "orc-chart-label";
        caption.textContent = unit ? captionText + " · " + unit : captionText;
        this.append(caption);
      }
      if (!data.length) {
        const empty = document.createElement("span");
        empty.className = "orc-chart-label";
        empty.textContent = "No chart data";
        this.append(empty);
        return;
      }
      const pad = spark ? { top: 2, right: 2, bottom: 2, left: 2 }
        : { top: 8, right: 8, bottom: 22, left: 40 };
      const plotWidth = Math.max(1, width - pad.left - pad.right);
      const plotHeight = Math.max(1, height - pad.top - pad.bottom);
      const values = data.map((point) => point.value);
      const minAttr = this.getAttribute("min");
      const maxAttr = this.getAttribute("max");
      const rawMin = minAttr === null ? Math.min(0, ...values) : Number(minAttr);
      const rawMax = maxAttr === null ? Math.max(...values) : Number(maxAttr);
      const step = spark ? 1 : niceStep((rawMax - rawMin || 1) / 4);
      let bottom = Number.isFinite(rawMin) ? rawMin : 0;
      let top = Number.isFinite(rawMax) ? rawMax : 1;
      if (!spark) {
        bottom = Math.floor(bottom / step) * step;
        top = Math.ceil(top / step) * step;
      }
      if (!(top > bottom)) top = bottom + step;
      const range = top - bottom;
      const xAt = (index) => kind === "bar" || spark
        ? pad.left + ((index + 0.5) / data.length) * plotWidth
        : data.length === 1 ? pad.left + plotWidth / 2
          : pad.left + (index / (data.length - 1)) * plotWidth;
      const yAt = (value) => pad.top + (1 - (value - bottom) / range) * plotHeight;
      const baseline = Math.min(pad.top + plotHeight, Math.max(pad.top, yAt(0)));
      const pointTitle = (point) => {
        const title = svgNode("title", {});
        title.textContent = point.label + ": " + chartNumber(point.value) + (unit ? " " + unit : "");
        return title;
      };
      const svg = svgNode("svg", {
        viewBox: "0 0 " + width + " " + height,
        width,
        height,
        role: "img",
        "aria-label": (captionText ?? kind) + " chart, " + data.length + " points",
      });
      if (!spark) {
        for (let value = bottom; value <= top + step / 2; value += step) {
          const y = yAt(value);
          svg.append(svgNode("line", {
            x1: pad.left, x2: pad.left + plotWidth, y1: y, y2: y, class: "orc-chart-grid",
          }));
          const label = svgNode("text", {
            x: pad.left - 6, y: y + 3, "text-anchor": "end", class: "orc-chart-text",
          });
          label.textContent = chartNumber(value);
          svg.append(label);
        }
        const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotWidth / 56))));
        for (const [index, point] of data.entries()) {
          if (index % every !== 0 && index !== data.length - 1) continue;
          const label = svgNode("text", {
            x: xAt(index), y: height - 6, "text-anchor": "middle", class: "orc-chart-text",
          });
          label.textContent = point.label;
          svg.append(label);
        }
      }
      if (kind === "bar") {
        const slot = plotWidth / data.length;
        const barWidth = Math.max(2, Math.min(48, slot * 0.62));
        for (const [index, point] of data.entries()) {
          const y = yAt(point.value);
          const bar = svgNode("rect", {
            x: xAt(index) - barWidth / 2,
            y: Math.min(y, baseline),
            width: barWidth,
            height: Math.max(1, Math.abs(baseline - y)),
            rx: 2,
            class: "orc-chart-bar",
          });
          bar.append(pointTitle(point));
          svg.append(bar);
        }
      } else {
        const points = data.map((point, index) => [xAt(index), yAt(point.value)]);
        if (kind === "area") {
          const d = ["M", points[0][0], baseline]
            .concat(points.flatMap(([x, y]) => ["L", x, y]))
            .concat(["L", points[points.length - 1][0], baseline, "Z"])
            .join(" ");
          svg.append(svgNode("path", { d, class: "orc-chart-area" }));
        }
        svg.append(svgNode("polyline", {
          points: points.map(([x, y]) => x + "," + y).join(" "),
          class: "orc-chart-series",
        }));
        for (const [index, point] of data.entries()) {
          if (spark && index !== data.length - 1) continue;
          const dot = svgNode("circle", {
            cx: xAt(index), cy: yAt(point.value), r: spark ? 2.5 : 3, class: "orc-chart-point",
          });
          if (!spark) dot.append(pointTitle(point));
          svg.append(dot);
        }
      }
      this.append(svg);
    }
  });
  define("orc-stat", class extends HTMLElement {
    static observedAttributes = ["label", "value"];
    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    render() {
      this.classList.add("orc-stat");
      const label = document.createElement("span");
      label.className = "orc-stat-label";
      label.textContent = this.getAttribute("label") ?? "";
      const value = document.createElement("span");
      value.className = "orc-stat-value";
      value.textContent = this.getAttribute("value") ?? "";
      this.replaceChildren(label, value);
    }
  });
  define("orc-badge", class extends HTMLElement {
    static observedAttributes = ["tone"];
    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    render() {
      this.classList.add("orc-badge");
      for (const tone of ["success", "warning", "error"]) {
        this.classList.toggle("orc-badge-" + tone, this.getAttribute("tone") === tone);
      }
    }
  });
  define("orc-table", class extends HTMLElement {
    connectedCallback() {
      this.classList.add("orc-table-wrap");
      this.style.display = "block";
      queueMicrotask(() => this.querySelector(":scope > table")?.classList.add("orc-table"));
    }
  });
  let nextId = 0;
  const uniqueId = () => {
    let id;
    do { id = "orc-kit-tab-" + ++nextId; } while (document.getElementById(id));
    return id;
  };
  define("orc-tabs", class extends HTMLElement {
    connectedCallback() { queueMicrotask(() => this.mount()); }
    mount() {
      if (this.querySelector(":scope > .orc-tab-list")) return;
      this.classList.add("orc-tabs");
      const list = document.createElement("div");
      list.className = "orc-tab-list";
      list.setAttribute("role", "tablist");
      list.setAttribute("aria-label", this.getAttribute("label") ?? "Tabs");
      list.setAttribute("aria-orientation", this.getAttribute("orientation") === "vertical" ? "vertical" : "horizontal");
      let selected;
      for (const panel of Array.from(this.children).filter((child) => child.localName === "orc-tab")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "orc-tab";
        button.id = uniqueId();
        button.textContent = panel.getAttribute("label") ?? "Tab";
        button.disabled = panel.hasAttribute("disabled");
        panel.id ||= uniqueId();
        panel.classList.add("orc-tab-panel");
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", button.id);
        panel.tabIndex = 0;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", panel.id);
        button.setAttribute("data-orc-tab", "");
        button.dataset.orcPanel = panel.id;
        button.setAttribute("aria-selected", "false");
        button.tabIndex = -1;
        panel.hidden = true;
        if (!button.disabled && (!selected || panel.hasAttribute("selected"))) selected = button;
        list.append(button);
      }
      this.prepend(list);
      if (selected) selectTab(selected);
    }
  });
};`;

// Light-DOM elements reuse the kit's styles and tab controller inside each sandbox.
// Attribute values become text nodes; they never become executable markup.
export const ORC_KIT_ELEMENTS_JS = `const registerOrcElements = (selectTab) => {
  const define = (name, element) => {
    if (!customElements.get(name)) customElements.define(name, element);
  };
  for (const name of ["page", "grid", "row", "card", "chart"]) {
    define("orc-" + name, class extends HTMLElement {
      connectedCallback() { this.classList.add("orc-" + name); }
    });
  }
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

"""ORC Docling adapter: one job per process, ORC-owned JSON written to <output>.

Usage: python -I docling_parse.py <input> <output.json> <models-dir> [--ocr auto|force|off] [--max-pages N]
Diagnostics go to stderr. Exit 0 = result written (status may still be partial/failed).
Runs offline: models come from <models-dir>, never from the network.
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

t0 = time.perf_counter()
ap = argparse.ArgumentParser()
ap.add_argument("input")
ap.add_argument("output")
ap.add_argument("models")
ap.add_argument("--ocr", choices=["auto", "force", "off"], default="auto")
ap.add_argument("--max-pages", type=int, default=500)
ap.add_argument("--max-bytes", type=int, default=100 * 1024 * 1024)
args = ap.parse_args()

src = Path(args.input)
result = {
    "schema_version": 1,
    "parser": {"id": "docling", "version": "unknown", "options": {"ocr": args.ocr}},
    "source_sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
    "status": "failed",
    "blocks": [],
    "markdown": "",
    "warnings": [],
}

try:
    from importlib.metadata import version

    from docling.datamodel.base_models import ConversionStatus, InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption
    from docling_core.types.doc import DocItemLabel, TableItem

    t_import = time.perf_counter()
    result["parser"]["version"] = version("docling")
    opts = PdfPipelineOptions(artifacts_path=args.models, do_table_structure=True, do_ocr=args.ocr != "off")
    opts.ocr_options = RapidOcrOptions(force_full_page_ocr=args.ocr == "force")
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=opts),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=opts),
        }
    )
    kinds = {
        DocItemLabel.TITLE: "heading",
        DocItemLabel.SECTION_HEADER: "heading",
        DocItemLabel.LIST_ITEM: "list_item",
        DocItemLabel.CODE: "code",
        DocItemLabel.TABLE: "table",
    }
    conv = converter.convert(src, raises_on_error=False, max_num_pages=args.max_pages, max_file_size=args.max_bytes)
    result["status"] = {ConversionStatus.SUCCESS: "ok", ConversionStatus.PARTIAL_SUCCESS: "partial"}.get(
        conv.status, "failed"
    )
    result["warnings"] += [f"{e.component_type}: {e.error_message}" for e in conv.errors]
    doc = conv.document
    path: list[tuple[int, str]] = []
    for item, _level in doc.iterate_items():
        label = getattr(item, "label", None)
        kind = kinds.get(label, "paragraph")
        block = {"kind": kind}
        if isinstance(item, TableItem):
            block["rows"] = [[cell.text for cell in row] for row in item.data.grid]
            block["text"] = "\n".join(" | ".join(r) for r in block["rows"])
        else:
            block["text"] = getattr(item, "text", "") or ""
        if kind == "heading":
            # Docling: title = 0, section headers 1..n. ORC: 1..6.
            level = 1 if label == DocItemLabel.TITLE else min(6, int(getattr(item, "level", 1) or 1) + 1)
            block["level"] = level
            path = [h for h in path if h[0] < level] + [(level, block["text"])]
        block["heading_path"] = [h[1] for h in path]
        prov = getattr(item, "prov", None) or []
        if prov:
            p = prov[0]
            block["locator"] = {"page": p.page_no, "bbox": [round(v, 1) for v in p.bbox.as_tuple()]}
        if block["text"] or block.get("rows"):
            result["blocks"].append(block)
    result["markdown"] = doc.export_to_markdown()
    if not result["blocks"] and result["status"] == "ok":
        result["status"] = "partial"
        result["warnings"].append("no text extracted")
    result["timings_ms"] = {
        "import": round((t_import - t0) * 1000),
        "convert": round((time.perf_counter() - t_import) * 1000),
    }
except Exception as e:  # noqa: BLE001 - every failure is reported in the ORC result
    result["status"] = "failed"
    result["blocks"] = []
    result["warnings"].append(f"{type(e).__name__}: {e}"[:500])

Path(args.output).write_bytes(json.dumps(result, ensure_ascii=False).encode("utf-8"))
sys.exit(0)
